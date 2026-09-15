/*
 * F28 test-only identity/recovery store helper.
 *
 * Two compile-time anchored roots, and no way to express any other location:
 * the graph tree under the approved Logseq Test root, and a new explicitly
 * owned experimental profile tree. Both roots are supplied by the caller and
 * must equal these constants byte-for-byte. Every other element is a validated
 * single component or a validated relative graph path.
 *
 * This is the additional boundary described in PERSISTENT_IDENTITY_DESIGN.md.
 * It does not relax any guard of filesystem_helper.c or working_tree_helper.c,
 * which are unchanged.
 */
#define _DARWIN_C_SOURCE 1
#include <CommonCrypto/CommonDigest.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define GRAPH_ROOT "/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test"
#define PROFILE_ROOT "/Users/johnlee/Library/Application Support/Logseq OG F28 IdentityExp"
#define MAX_INPUT (16u * 1024u * 1024u)
#define MAX_PATH_BYTES 1024u
#define MAX_RECORD (4u * 1024u * 1024u)
#define MAX_ENTRIES 512u
#define SIDECAR_NAME "identity-v1.json"
#define DEVICE_NAME "device.json"
/*
 * The incoming-application journal lives at exactly one compile-time name in
 * the owned profile directory. No caller can express any other name, path or
 * component for it, so the journal commands add no reachable location.
 */
#define JOURNAL_NAME "incoming-journal.json"

typedef struct {
  char command[24], run[96], owner[129], graphdir[81], profiledir[81];
  char tx[65], attempt[33], target[16], failure[40], expect[72], relocate[16];
  char *note_path;
  unsigned char *data;
  size_t data_len;
} Request;

static void die(const char *message) {
  fprintf(stderr, "REFUSED: %s (errno=%d)\n", message, errno);
  exit(23);
}

static void *xmalloc(size_t amount) {
  void *value = malloc(amount ? amount : 1);
  if (!value) die("allocation failed");
  return value;
}

static char *xstrdup(const char *value) {
  size_t length = strlen(value);
  char *copy = xmalloc(length + 1);
  memcpy(copy, value, length + 1);
  return copy;
}

static void sha256(const void *data, size_t length, char output[65]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data, (CC_LONG)length, digest);
  for (int index = 0; index < 32; index++)
    (void)snprintf(output + index * 2, 3, "%02x", digest[index]);
  output[64] = 0;
}

static int hex_value(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static int hex64(const char *value) {
  if (strlen(value) != 64) return 0;
  for (size_t index = 0; index < 64; index++)
    if (hex_value(value[index]) < 0) return 0;
  return 1;
}

static int safe_component(const char *value) {
  size_t length = strlen(value);
  if (!length || length > 80 || !strcmp(value, ".") || !strcmp(value, "..")) return 0;
  for (size_t index = 0; index < length; index++)
    if (!isalnum((unsigned char)value[index]) && value[index] != '_' && value[index] != '-') return 0;
  return 1;
}

static int valid_utf8(const unsigned char *value, size_t length) {
  for (size_t index = 0; index < length;) {
    unsigned char byte = value[index++];
    if (!byte) return 0;
    if (byte < 0x80) continue;
    unsigned needed = byte >= 0xC2 && byte <= 0xDF ? 1 : byte >= 0xE0 && byte <= 0xEF ? 2 : byte >= 0xF0 && byte <= 0xF4 ? 3 : 99;
    if (needed == 99 || index + needed > length) return 0;
    unsigned char first = value[index];
    if ((byte == 0xE0 && first < 0xA0) || (byte == 0xED && first >= 0xA0) ||
        (byte == 0xF0 && first < 0x90) || (byte == 0xF4 && first >= 0x90)) return 0;
    for (unsigned offset = 0; offset < needed; offset++)
      if ((value[index++] & 0xC0) != 0x80) return 0;
  }
  return 1;
}

static void read_all(unsigned char **output, size_t *length) {
  size_t capacity = 4096, used = 0;
  unsigned char *buffer = xmalloc(capacity);
  for (;;) {
    if (used == capacity) {
      if (capacity >= MAX_INPUT) die("protocol too large");
      capacity *= 2;
      if (capacity > MAX_INPUT) capacity = MAX_INPUT;
      unsigned char *grown = realloc(buffer, capacity);
      if (!grown) die("allocation failed");
      buffer = grown;
    }
    ssize_t amount = read(STDIN_FILENO, buffer + used, capacity - used);
    if (amount < 0 && errno == EINTR) continue;
    if (amount < 0) die("protocol read failed");
    if (!amount) break;
    used += (size_t)amount;
  }
  for (size_t index = 0; index < used; index++) if (!buffer[index]) die("embedded NUL refused");
  unsigned char *ended = realloc(buffer, used + 1);
  if (!ended) die("allocation failed");
  ended[used] = 0;
  *output = ended;
  *length = used;
}

static char *line(char **cursor, const char *key) {
  char *start = *cursor, *newline = strchr(start, '\n');
  if (!newline) die("truncated protocol");
  *newline = 0;
  size_t key_length = strlen(key);
  if (strncmp(start, key, key_length) || start[key_length] != '\t') die("unexpected protocol field");
  *cursor = newline + 1;
  return start + key_length + 1;
}

static void copy_text(char *destination, size_t capacity, const char *source, const char *error) {
  if (strlen(source) >= capacity) die(error);
  strcpy(destination, source);
}

static unsigned char *unhex(const char *value, size_t maximum, size_t *length) {
  size_t source_length = strlen(value);
  if ((source_length & 1u) || source_length / 2 > maximum) die("invalid hex length");
  unsigned char *decoded = xmalloc(source_length / 2 + 1);
  for (size_t index = 0; index < source_length; index += 2) {
    int high = hex_value(value[index]), low = hex_value(value[index + 1]);
    if (high < 0 || low < 0) die("invalid hex");
    decoded[index / 2] = (unsigned char)(high * 16 + low);
  }
  decoded[source_length / 2] = 0;
  *length = source_length / 2;
  return decoded;
}

/* Graph-relative note path: relative, no traversal, no links, .md/.org only. */
static void valid_note_path(const char *path) {
  size_t length = strlen(path);
  if (!length || length > MAX_PATH_BYTES || path[0] == '/' || strchr(path, '\\') || strstr(path, "//"))
    die("unsafe note path");
  if (!((length >= 3 && !strcmp(path + length - 3, ".md")) ||
        (length >= 4 && !strcmp(path + length - 4, ".org"))))
    die("unsupported note extension");
  char *copy = xstrdup(path), *save = NULL, *part = strtok_r(copy, "/", &save);
  size_t count = 0;
  while (part) {
    if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) die("note path traversal");
    count++;
    part = strtok_r(NULL, "/", &save);
  }
  free(copy);
  if (!count) die("invalid note path");
}

static Request parse(void) {
  unsigned char *raw;
  size_t raw_length;
  read_all(&raw, &raw_length);
  (void)raw_length;
  char *cursor = (char *)raw;
  Request request = {0};
  if (strcmp(line(&cursor, "MAGIC"), "F28ID1")) die("bad protocol magic");
  copy_text(request.command, sizeof request.command, line(&cursor, "COMMAND"), "bad command");
  size_t length;
  unsigned char *value = unhex(line(&cursor, "GRAPHROOTHEX"), sizeof(GRAPH_ROOT) - 1, &length);
  if (length != strlen(GRAPH_ROOT) || memcmp(value, GRAPH_ROOT, length)) die("graph root mismatch");
  free(value);
  value = unhex(line(&cursor, "PROFILEROOTHEX"), sizeof(PROFILE_ROOT) - 1, &length);
  if (length != strlen(PROFILE_ROOT) || memcmp(value, PROFILE_ROOT, length)) die("profile root mismatch");
  free(value);
  copy_text(request.run, sizeof request.run, line(&cursor, "RUN"), "bad run");
  copy_text(request.owner, sizeof request.owner, line(&cursor, "OWNER"), "bad owner");
  copy_text(request.graphdir, sizeof request.graphdir, line(&cursor, "GRAPHDIR"), "bad graph directory");
  copy_text(request.profiledir, sizeof request.profiledir, line(&cursor, "PROFILEDIR"), "bad profile directory");
  copy_text(request.tx, sizeof request.tx, line(&cursor, "TX"), "bad transaction");
  copy_text(request.attempt, sizeof request.attempt, line(&cursor, "ATTEMPT"), "bad attempt");
  copy_text(request.expect, sizeof request.expect, line(&cursor, "EXPECT"), "bad expectation");
  copy_text(request.target, sizeof request.target, line(&cursor, "TARGET"), "bad target");
  copy_text(request.failure, sizeof request.failure, line(&cursor, "FAILURE"), "bad failure point");
  copy_text(request.relocate, sizeof request.relocate, line(&cursor, "RELOCATE"), "bad relocation choice");
  request.note_path = (char *)unhex(line(&cursor, "NOTEPATHHEX"), MAX_PATH_BYTES, &length);
  if (length && !valid_utf8((unsigned char *)request.note_path, length)) die("note path is not UTF-8");
  request.data = unhex(line(&cursor, "DATAHEX"), MAX_RECORD, &request.data_len);
  if (strcmp(line(&cursor, "END"), "1") || *cursor) die("trailing protocol data");

  const char *commands[] = {"init", "put-note", "read-note", "hash-graph",
                            "read-records", "write-record", "clear-intent",
                            "write-journal", "read-journal"};
  int known = 0;
  for (size_t index = 0; index < sizeof commands / sizeof commands[0]; index++)
    if (!strcmp(request.command, commands[index])) known = 1;
  if (!known) die("unknown command");

  const char *targets[] = {"none", "sidecar", "device", "intent", "evidence"};
  known = 0;
  for (size_t index = 0; index < sizeof targets / sizeof targets[0]; index++)
    if (!strcmp(request.target, targets[index])) known = 1;
  if (!known) die("unknown record target");

  const char *failures[] = {"none", "before-stage", "after-stage", "after-rename",
                            "before-clear", "after-clear"};
  known = 0;
  for (size_t index = 0; index < sizeof failures / sizeof failures[0]; index++)
    if (!strcmp(request.failure, failures[index])) known = 1;
  if (!known) die("unknown failure point");

  const char *relocations[] = {"none", "graph", "profile"};
  known = 0;
  for (size_t index = 0; index < sizeof relocations / sizeof relocations[0]; index++)
    if (!strcmp(request.relocate, relocations[index])) known = 1;
  if (!known) die("unknown relocation choice");

  if (!safe_component(request.run) || !safe_component(request.graphdir) ||
      !safe_component(request.profiledir) || !hex64(request.owner) || !hex64(request.tx))
    die("unsafe request identity");
  if (strlen(request.attempt) != 32) die("unsafe attempt identity");
  for (size_t index = 0; index < 32; index++)
    if (hex_value(request.attempt[index]) < 0) die("unsafe attempt identity");
  if (strcmp(request.expect, "absent") && strcmp(request.expect, "any") && !hex64(request.expect))
    die("unsafe destination expectation");
  return request;
}

static int open_directory(int parent, const char *name) {
  int descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) die("directory open refused");
  struct stat status;
  if (fstat(descriptor, &status) || !S_ISDIR(status.st_mode)) die("not a directory");
  return descriptor;
}

static int make_directory(int parent, const char *name) {
  if (mkdirat(parent, name, 0700) && errno != EEXIST) die("mkdir refused");
  return open_directory(parent, name);
}

static void identity(int descriptor, dev_t *device, ino_t *inode) {
  struct stat status;
  if (fstat(descriptor, &status)) die("identity failed");
  *device = status.st_dev;
  *inode = status.st_ino;
}

/* Walk an anchored root from "/" one component at a time, never following. */
static int anchored_root(const char *root) {
  int descriptor = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (descriptor < 0) die("root open failed");
  char *copy = xstrdup(root), *save = NULL, *part = strtok_r(copy, "/", &save);
  while (part) {
    int next = open_directory(descriptor, part);
    close(descriptor);
    descriptor = next;
    part = strtok_r(NULL, "/", &save);
  }
  free(copy);
  return descriptor;
}

static int present(int parent, const char *name) {
  struct stat status;
  if (!fstatat(parent, name, &status, AT_SYMLINK_NOFOLLOW)) return 1;
  if (errno == ENOENT) return 0;
  die("entry status failed");
  return 0;
}

static void full_sync(int descriptor) {
  int result;
  do { result = fcntl(descriptor, F_FULLFSYNC); } while (result && errno == EINTR);
  if (result) die("required F_FULLFSYNC failed");
}

static void sync_directory(int descriptor) {
  int result;
  do { result = fsync(descriptor); } while (result && errno == EINTR);
  if (result) die("directory synchronization failed");
}

static void write_all(int descriptor, const void *data, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t amount = write(descriptor, (const unsigned char *)data + written, length - written);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) die("short write");
    written += (size_t)amount;
  }
}

static unsigned char *read_entry(int parent, const char *name, size_t maximum, size_t *length) {
  int descriptor = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) die("file open refused");
  struct stat status;
  if (fstat(descriptor, &status) || !S_ISREG(status.st_mode) || status.st_size < 0 ||
      (uint64_t)status.st_size > maximum) die("invalid regular file");
  size_t total = (size_t)status.st_size, remaining = total;
  unsigned char *data = xmalloc(total + 1), *at = data;
  while (remaining) {
    ssize_t amount = read(descriptor, at, remaining);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) die("short read");
    at += amount;
    remaining -= (size_t)amount;
  }
  if (close(descriptor)) die("close failed");
  data[total] = 0;
  *length = total;
  return data;
}

static void verify_owner(int directory, const char *owner) {
  char expected[132];
  int expected_length = snprintf(expected, sizeof expected, "%s\n", owner);
  size_t actual_length;
  unsigned char *actual = read_entry(directory, "OWNER", sizeof expected, &actual_length);
  if (actual_length != (size_t)expected_length || memcmp(actual, expected, actual_length))
    die("ownership refused");
  free(actual);
}

static void write_owner(int directory, const char *owner) {
  char text[132];
  int text_length = snprintf(text, sizeof text, "%s\n", owner);
  if (present(directory, "OWNER")) { verify_owner(directory, owner); return; }
  int descriptor = openat(directory, "OWNER", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) die("ownership creation refused");
  write_all(descriptor, text, (size_t)text_length);
  full_sync(descriptor);
  if (close(descriptor)) die("close failed");
  sync_directory(directory);
}

/*
 * One cooperative lock per owned run/profile, on a stable anchored inode. It
 * serializes participating helper invocations only: OG, Finder, cloud agents
 * and external editors do not honour it, and it is not a durability mechanism.
 */
static int lock_descriptor = -1;

static void acquire_lock(int profile, int exclusive) {
  int descriptor = openat(profile, "LOCK", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) die("cooperative lock open refused");
  struct stat status;
  if (fstat(descriptor, &status) || !S_ISREG(status.st_mode)) die("cooperative lock is not a regular file");
  if (flock(descriptor, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB))
    die("existing cooperative lock refused");
  lock_descriptor = descriptor;
}

static void inject(const Request *request, const char *point) {
  if (!strcmp(request->failure, point)) {
    fprintf(stderr, "INJECTED: %s\n", point);
    exit(25);
  }
}

/*
 * One record write: exclusive pending in the destination directory, full sync,
 * directory-relative rename, directory sync, then a non-following read-back of
 * the installed bytes. Atomic for a reader of this one directory only.
 */
static void publish_entry(const Request *request, int directory, const char *name,
                          const unsigned char *data, size_t length) {
  /*
   * A fresh unpredictable name per attempt: a retained pending file from an
   * interrupted attempt is evidence and is never reopened, truncated or reused.
   */
  char pending[256];
  (void)snprintf(pending, sizeof pending, "%s.%s.%s.pending", name, request->tx, request->attempt);
  inject(request, "before-stage");
  if (present(directory, pending)) die("pending entry already present");
  /*
   * An existing destination must be an ordinary file. A symbolic link or other
   * entry is never replaced: it is preserved and the write is refused.
   */
  struct stat destination;
  if (!fstatat(directory, name, &destination, AT_SYMLINK_NOFOLLOW)) {
    if (!S_ISREG(destination.st_mode)) die("destination entry is not a regular file");
  } else if (errno != ENOENT) die("destination status failed");
  int descriptor = openat(directory, pending, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) die("exclusive pending creation refused");
  write_all(descriptor, data, length);
  full_sync(descriptor);
  struct stat staged;
  if (fstat(descriptor, &staged)) die("pending identity failed");
  if (close(descriptor)) die("close failed");
  sync_directory(directory);
  inject(request, "after-stage");

  /*
   * Recheck the destination immediately before the rename, not at the caller's
   * earlier read. A publication derived from a stale read must refuse rather
   * than overwrite whatever is there now.
   */
  if (strcmp(request->expect, "any")) {
    struct stat current;
    int exists = !fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW);
    if (!exists && errno != ENOENT) die("destination status failed");
    if (!strcmp(request->expect, "absent")) {
      if (exists) die("destination precondition failed: entry present");
    } else {
      if (!exists) die("destination precondition failed: entry absent");
      size_t current_length;
      unsigned char *current_data = read_entry(directory, name, MAX_RECORD, &current_length);
      char current_hash[65];
      sha256(current_data, current_length, current_hash);
      free(current_data);
      if (strcmp(current_hash, request->expect))
        die("destination precondition failed: content differs");
    }
  }

  if (renameat(directory, pending, directory, name)) die("record rename refused");
  sync_directory(directory);
  inject(request, "after-rename");

  int installed = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (installed < 0) die("installed record open refused");
  struct stat actual;
  if (fstat(installed, &actual) || !S_ISREG(actual.st_mode)) die("installed record is not regular");
  if (actual.st_dev != staged.st_dev || actual.st_ino != staged.st_ino)
    die("installed record identity changed");
  close(installed);
  size_t actual_length;
  unsigned char *readback = read_entry(directory, name, MAX_RECORD, &actual_length);
  if (actual_length != length || memcmp(readback, data, length)) die("installed record bytes differ");
  free(readback);
}

static void print_hex(const char *key, const unsigned char *data, size_t length) {
  printf("%s ", key);
  for (size_t index = 0; index < length; index++) printf("%02x", data[index]);
  printf("\n");
}

static void print_entry(int directory, const char *key, const char *name) {
  if (!present(directory, name)) { printf("%s -\n", key); return; }
  size_t length;
  unsigned char *data = read_entry(directory, name, MAX_RECORD, &length);
  print_hex(key, data, length);
  free(data);
}

/* Count retained ".pending" entries so evidence retention is observable. */
static size_t count_pending(int directory) {
  int duplicate = dup(directory);
  if (duplicate < 0) die("dup failed");
  DIR *handle = fdopendir(duplicate);
  if (!handle) die("directory listing refused");
  /* dup shares the directory offset, so a second pass must rewind. */
  rewinddir(handle);
  size_t count = 0;
  struct dirent *entry;
  while ((entry = readdir(handle))) {
    size_t length = strlen(entry->d_name);
    if (length > 8 && !strcmp(entry->d_name + length - 8, ".pending")) count++;
  }
  closedir(handle);
  return count;
}

/* Count ordinary entries, so retained recovery evidence is observable. */
static size_t count_entries(int directory) {
  int duplicate = dup(directory);
  if (duplicate < 0) die("dup failed");
  DIR *handle = fdopendir(duplicate);
  if (!handle) die("directory listing refused");
  /* dup shares the directory offset, so a second pass must rewind. */
  rewinddir(handle);
  size_t count = 0;
  struct dirent *entry;
  while ((entry = readdir(handle))) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) count++;
  }
  closedir(handle);
  return count;
}

/*
 * List every retained publication intent. Recovery must see an intent it was
 * not told about, so an outstanding transaction cannot be bypassed by asking
 * only about a different one.
 */
static void print_intents(int directory) {
  int duplicate = dup(directory);
  if (duplicate < 0) die("dup failed");
  DIR *handle = fdopendir(duplicate);
  if (!handle) die("directory listing refused");
  /* dup shares the directory offset, so a second pass must rewind. */
  rewinddir(handle);
  size_t count = 0;
  struct dirent *entry;
  printf("INTENTS ");
  while ((entry = readdir(handle))) {
    size_t length = strlen(entry->d_name);
    if (length != 7 + 64 + 5 || strncmp(entry->d_name, "intent-", 7) ||
        strcmp(entry->d_name + 7 + 64, ".json")) continue;
    printf("%s%.64s", count ? "," : "", entry->d_name + 7);
    count++;
  }
  closedir(handle);
  if (!count) printf("-");
  printf("\n");
}

typedef struct { char *name; unsigned char type; } Entry;

static int compare_entries(const void *left, const void *right) {
  return strcmp(((const Entry *)left)->name, ((const Entry *)right)->name);
}

/*
 * Hash every Markdown/Org note of the graph tree by exact relative path and
 * exact bytes, excluding the adapter's hidden logseq/.og-sync. Directory
 * entries are deliberately not hashed: enrollment may create the ordinary
 * hidden container.
 *
 * Any other regular file — a Finder-written .DS_Store, an editor swap file, a
 * cloud placeholder — is counted separately and never mixed into the hash.
 * Hashing those made two graphs with byte-identical notes compare unequal
 * whenever the operating system happened to write one during a slow run, and
 * made "no note byte changed" a claim about files that are not notes. They are
 * reported so nothing is silently absorbed. Symbolic links are recorded,
 * never followed.
 */
static int is_note_name(const char *name) {
  size_t length = strlen(name);
  return (length >= 3 && !strcmp(name + length - 3, ".md")) ||
         (length >= 4 && !strcmp(name + length - 4, ".org"));
}
static void hash_tree(int directory, const char *relative, CC_SHA256_CTX *context,
                      size_t *files, size_t *extra) {
  int duplicate = dup(directory);
  if (duplicate < 0) die("dup failed");
  DIR *handle = fdopendir(duplicate);
  if (!handle) die("directory listing refused");
  /* dup shares the directory offset, so a second pass must rewind. */
  rewinddir(handle);
  Entry entries[MAX_ENTRIES];
  size_t count = 0;
  struct dirent *entry;
  while ((entry = readdir(handle))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (count >= MAX_ENTRIES) die("too many entries");
    entries[count].name = xstrdup(entry->d_name);
    entries[count].type = entry->d_type;
    count++;
  }
  closedir(handle);
  qsort(entries, count, sizeof(Entry), compare_entries);
  for (size_t index = 0; index < count; index++) {
    char child[MAX_PATH_BYTES * 2];
    (void)snprintf(child, sizeof child, "%s%s%s", relative, *relative ? "/" : "", entries[index].name);
    if (!strcmp(child, "logseq/.og-sync")) { free(entries[index].name); continue; }
    struct stat status;
    if (fstatat(directory, entries[index].name, &status, AT_SYMLINK_NOFOLLOW)) die("entry status failed");
    if (S_ISLNK(status.st_mode)) {
      CC_SHA256_Update(context, "L\0", 2);
      CC_SHA256_Update(context, child, (CC_LONG)strlen(child));
    } else if (S_ISDIR(status.st_mode)) {
      int nested = open_directory(directory, entries[index].name);
      hash_tree(nested, child, context, files, extra);
      close(nested);
    } else if (!is_note_name(entries[index].name)) {
      (*extra)++;
    } else {
      size_t length;
      unsigned char *data = read_entry(directory, entries[index].name, MAX_RECORD, &length);
      CC_SHA256_Update(context, "F\0", 2);
      CC_SHA256_Update(context, child, (CC_LONG)strlen(child));
      CC_SHA256_Update(context, data, (CC_LONG)length);
      free(data);
      (*files)++;
    }
    free(entries[index].name);
  }
}

/*
 * An anchored directory: the retained handle, the device/inode it named when
 * opened, and the parent handle plus entry name that must still name it.
 */
typedef struct {
  int descriptor;
  int parent;
  const char *name;
  dev_t device;
  ino_t inode;
} Anchor;

static Anchor anchor_of(int descriptor, int parent, const char *name) {
  Anchor anchor = { descriptor, parent, name, 0, 0 };
  identity(descriptor, &anchor.device, &anchor.inode);
  return anchor;
}

/*
 * Verify that the expected parent-relative entry still names the retained
 * handle's directory: re-open the entry from the retained parent without
 * following, and compare device/inode with the handle. A same-descriptor
 * fstat cannot do this — an open descriptor keeps referencing its original
 * directory after the pathname is renamed or replaced, so its identity never
 * changes and the check was vacuous.
 *
 * This is a check, not a prevention. It detects, at the moment of the check,
 * an entry renamed away (the re-open fails) or replaced by a different
 * directory or a symbolic link (the re-open is refused or the identity
 * differs). It detects nothing that happens after it: the verification and
 * the caller's use of the result remain separate operations, so a
 * check-to-use interval remains.
 */
static void reverify_entry(const Anchor *anchor, const char *message) {
  int current = openat(anchor->parent, anchor->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) die(message);
  struct stat status;
  int failed = fstat(current, &status) ||
               status.st_dev != anchor->device || status.st_ino != anchor->inode;
  if (close(current) && !failed) die("verification close failed");
  if (failed) die(message);
}

/*
 * Test-only simulated relocation, standing in for an external process that
 * renames an owned directory aside and leaves a different directory at its
 * entry while this command is between acquisition and verification.
 * Production callers never set RELOCATE. The rename stays inside the owned
 * run, and both the renamed original and the replacement are preserved as
 * evidence for the caller to inspect.
 */
static void relocate_owned(int parent, const char *name) {
  char aside[96];
  (void)snprintf(aside, sizeof aside, "%s.relocated", name);
  if (renameat(parent, name, parent, aside)) die("test relocation rename refused");
  if (mkdirat(parent, name, 0700)) die("test relocation replacement refused");
}

static Anchor open_graph(const Request *request) {
  int root = anchored_root(GRAPH_ROOT);
  int run = open_directory(root, request->run);
  close(root);
  verify_owner(run, request->owner);
  int graph = open_directory(run, request->graphdir);
  /* The run handle is retained: the entry re-verification needs it. */
  return anchor_of(graph, run, request->graphdir);
}

static Anchor open_profile(const Request *request) {
  int root = anchored_root(PROFILE_ROOT);
  int run = open_directory(root, request->run);
  close(root);
  verify_owner(run, request->owner);
  int profile = open_directory(run, request->profiledir);
  verify_owner(profile, request->owner);
  /* The run handle is retained: the entry re-verification needs it. */
  return anchor_of(profile, run, request->profiledir);
}

/* Open (or create) the hidden graph-local sidecar directory. */
static int open_sidecar_directory(const Request *request, int graph, int create) {
  if (!create && !present(graph, "logseq")) return -1;
  int logseq = create ? make_directory(graph, "logseq") : open_directory(graph, "logseq");
  if (!create && !present(logseq, ".og-sync")) { close(logseq); return -1; }
  int sidecar = create ? make_directory(logseq, ".og-sync") : open_directory(logseq, ".og-sync");
  if (create) { sync_directory(logseq); write_owner(sidecar, request->owner); }
  else verify_owner(sidecar, request->owner);
  close(logseq);
  return sidecar;
}

static int note_parent(int graph, const char *path, char **leaf, int create) {
  char *copy = xstrdup(path), *slash = strrchr(copy, '/');
  int descriptor = dup(graph);
  if (descriptor < 0) die("dup failed");
  if (!slash) { *leaf = xstrdup(copy); free(copy); return descriptor; }
  *slash = 0;
  *leaf = xstrdup(slash + 1);
  char *save = NULL, *part = strtok_r(copy, "/", &save);
  while (part) {
    int next = create ? make_directory(descriptor, part) : open_directory(descriptor, part);
    close(descriptor);
    descriptor = next;
    part = strtok_r(NULL, "/", &save);
  }
  free(copy);
  return descriptor;
}

int main(void) {
  Request request = parse();
  char intent_name[96];
  (void)snprintf(intent_name, sizeof intent_name, "intent-%s.json", request.tx);

  if (!strcmp(request.command, "init")) {
    int root = anchored_root(GRAPH_ROOT);
    int run = make_directory(root, request.run);
    sync_directory(root);
    close(root);
    write_owner(run, request.owner);
    int graph = make_directory(run, request.graphdir);
    sync_directory(run);
    close(graph);
    close(run);

    int profile_parent = anchored_root("/Users/johnlee/Library/Application Support");
    int profile_root = make_directory(profile_parent, "Logseq OG F28 IdentityExp");
    sync_directory(profile_parent);
    close(profile_parent);
    int profile_run = make_directory(profile_root, request.run);
    sync_directory(profile_root);
    close(profile_root);
    write_owner(profile_run, request.owner);
    int profile = make_directory(profile_run, request.profiledir);
    sync_directory(profile_run);
    write_owner(profile, request.owner);
    int evidence = make_directory(profile, "evidence");
    acquire_lock(profile, 1);
    sync_directory(profile);
    close(evidence);
    close(profile);
    close(profile_run);
    printf("STATUS ok\n");
    return 0;
  }

  /*
   * Every remaining command serializes on the owned profile's cooperative lock
   * before opening anything else: reads share it, mutations take it exclusively.
   */
  int mutating = strcmp(request.command, "read-note") && strcmp(request.command, "read-records") &&
                 strcmp(request.command, "hash-graph") && strcmp(request.command, "read-journal");
  Anchor profile_anchor = open_profile(&request);
  acquire_lock(profile_anchor.descriptor, mutating);
  if (!strcmp(request.relocate, "profile"))
    relocate_owned(profile_anchor.parent, request.profiledir);

  if (!strcmp(request.command, "put-note")) {
    valid_note_path(request.note_path);
    Anchor graph_anchor = open_graph(&request);
    if (!strcmp(request.relocate, "graph")) relocate_owned(graph_anchor.parent, request.graphdir);
    int graph = graph_anchor.descriptor;
    char *leaf;
    int parent = note_parent(graph, request.note_path, &leaf, 1);
    publish_entry(&request, parent, leaf, request.data, request.data_len);
    free(leaf);
    close(parent);
    reverify_entry(&graph_anchor, "graph directory entry no longer names the opened directory");
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    close(graph);
    printf("STATUS ok\n");
    return 0;
  }

  if (!strcmp(request.command, "read-note")) {
    valid_note_path(request.note_path);
    Anchor graph_anchor = open_graph(&request);
    if (!strcmp(request.relocate, "graph")) relocate_owned(graph_anchor.parent, request.graphdir);
    char *leaf;
    int parent = note_parent(graph_anchor.descriptor, request.note_path, &leaf, 0);
    if (!present(parent, leaf)) {
      printf("STATUS ok\nDATA -\n");
    } else {
      size_t length;
      unsigned char *data = read_entry(parent, leaf, MAX_RECORD, &length);
      printf("STATUS ok\n");
      print_hex("DATA", data, length);
      free(data);
    }
    free(leaf);
    close(parent);
    reverify_entry(&graph_anchor, "graph directory entry no longer names the opened directory");
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    close(graph_anchor.descriptor);
    return 0;
  }

  if (!strcmp(request.command, "hash-graph")) {
    Anchor graph_anchor = open_graph(&request);
    if (!strcmp(request.relocate, "graph")) relocate_owned(graph_anchor.parent, request.graphdir);
    int graph = graph_anchor.descriptor;
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    size_t files = 0, extra = 0;
    hash_tree(graph, "", &context, &files, &extra);
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    char output[65];
    for (int index = 0; index < 32; index++) (void)snprintf(output + index * 2, 3, "%02x", digest[index]);
    output[64] = 0;
    close(graph);
    reverify_entry(&graph_anchor, "graph directory entry no longer names the opened directory");
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    printf("STATUS ok\nHASH %s\nCOUNT %zu\nEXTRA %zu\n", output, files, extra);
    return 0;
  }

  if (!strcmp(request.command, "read-records")) {
    Anchor graph_anchor = open_graph(&request);
    if (!strcmp(request.relocate, "graph")) relocate_owned(graph_anchor.parent, request.graphdir);
    int graph = graph_anchor.descriptor;
    int sidecar_directory = open_sidecar_directory(&request, graph, 0);
    int profile = profile_anchor.descriptor;
    printf("STATUS ok\n");
    if (sidecar_directory < 0) { printf("SIDECAR -\nGRAPHPENDING 0\n"); }
    else {
      print_entry(sidecar_directory, "SIDECAR", SIDECAR_NAME);
      printf("GRAPHPENDING %zu\n", count_pending(sidecar_directory));
      close(sidecar_directory);
    }
    print_entry(profile, "DEVICE", DEVICE_NAME);
    print_entry(profile, "INTENT", intent_name);
    printf("PROFILEPENDING %zu\n", count_pending(profile));
    print_intents(profile);
    if (present(profile, "evidence")) {
      int evidence = open_directory(profile, "evidence");
      printf("EVIDENCE %zu\n", count_entries(evidence));
      close(evidence);
    } else printf("EVIDENCE 0\n");
    printf("GRAPHDEVICE %lld\nGRAPHINODE %llu\n",
           (long long)graph_anchor.device, (unsigned long long)graph_anchor.inode);
    printf("PROFILEDEVICE %lld\nPROFILEINODE %llu\n",
           (long long)profile_anchor.device, (unsigned long long)profile_anchor.inode);
    reverify_entry(&graph_anchor, "graph directory entry no longer names the opened directory");
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    close(graph);
    return 0;
  }

  if (!strcmp(request.command, "write-record")) {
    if (!request.data_len) die("record body required");
    if (!valid_utf8(request.data, request.data_len)) die("record is not bounded UTF-8");
    if (!strcmp(request.target, "sidecar")) {
      Anchor graph_anchor = open_graph(&request);
      if (!strcmp(request.relocate, "graph")) relocate_owned(graph_anchor.parent, request.graphdir);
      int directory = open_sidecar_directory(&request, graph_anchor.descriptor, 1);
      publish_entry(&request, directory, SIDECAR_NAME, request.data, request.data_len);
      close(directory);
      reverify_entry(&graph_anchor, "graph directory entry no longer names the opened directory");
      close(graph_anchor.descriptor);
    } else if (!strcmp(request.target, "device") || !strcmp(request.target, "intent")) {
      publish_entry(&request, profile_anchor.descriptor,
                    !strcmp(request.target, "device") ? DEVICE_NAME : intent_name,
                    request.data, request.data_len);
    } else if (!strcmp(request.target, "evidence")) {
      int profile = profile_anchor.descriptor;
      int evidence = make_directory(profile, "evidence");
      char name[96];
      (void)snprintf(name, sizeof name, "uncertain-%s.json", request.tx);
      publish_entry(&request, evidence, name, request.data, request.data_len);
      close(evidence);
    } else die("record target required");
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    printf("STATUS ok\n");
    return 0;
  }

  /*
   * The incoming-application journal: one bounded device-local record at one
   * fixed name in the owned profile directory. It takes the same destination
   * precondition, the same exclusive lock, the same staged-write/recheck/rename
   * publication and the same entry re-verification as every other record. There
   * is deliberately no clear-journal command: a finished journal is retained and
   * the next transaction replaces it under its exact hash.
   */
  if (!strcmp(request.command, "write-journal")) {
    if (!request.data_len) die("journal body required");
    if (!valid_utf8(request.data, request.data_len)) die("journal is not bounded UTF-8");
    publish_entry(&request, profile_anchor.descriptor, JOURNAL_NAME,
                  request.data, request.data_len);
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    printf("STATUS ok\n");
    return 0;
  }

  if (!strcmp(request.command, "read-journal")) {
    printf("STATUS ok\n");
    print_entry(profile_anchor.descriptor, "JOURNAL", JOURNAL_NAME);
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    return 0;
  }

  if (!strcmp(request.command, "clear-intent")) {
    int profile = profile_anchor.descriptor;
    inject(&request, "before-clear");
    if (present(profile, intent_name) && unlinkat(profile, intent_name, 0)) die("intent removal refused");
    inject(&request, "after-clear");
    sync_directory(profile);
    if (present(profile, intent_name)) die("intent still present after removal");
    reverify_entry(&profile_anchor, "profile directory entry no longer names the opened directory");
    printf("STATUS ok\n");
    return 0;
  }

  die("unreachable command");
  return 23;
}
