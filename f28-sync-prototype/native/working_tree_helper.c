#define _DARWIN_C_SOURCE 1
#include <CommonCrypto/CommonDigest.h>
#include <ctype.h>
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

#define ROOT "/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test"
#define MAX_INPUT (16u * 1024u * 1024u)
#define MAX_ACTIONS 128u
#define MAX_PATH_BYTES 1024u
#define MAX_CONTENT (1024u * 1024u)

typedef struct {
  char kind[8];
  char *file_id;
  char *old_path;
  unsigned char *old_data;
  size_t old_len;
  char *new_path;
  unsigned char *new_data;
  size_t new_len;
  char old_hash[65];
  char new_hash[65];
} Action;

typedef struct {
  char command[16], run[96], kase[96], owner[129], workdir[81], metadir[81];
  char basis_gen[65], target_gen[65], preview[72], plan[129], tx[65];
  char failure[40];
  char **ops;
  size_t op_count;
  Action *actions;
  size_t action_count;
  unsigned char *base_state, *state;
  size_t base_state_len, state_len;
} Request;

static void die(const char *message) {
  fprintf(stderr, "REFUSED: %s (errno=%d)\n", message, errno);
  exit(23);
}

static void *xmalloc(size_t amount) {
  void *value = malloc(amount ? amount : 1);
  if (!value)
    die("allocation failed");
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

static int fingerprint(const char *value) {
  return strlen(value) == 71 && !strncmp(value, "sha256:", 7) && hex64(value + 7);
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

static size_t number(const char *value, size_t maximum) {
  if (!*value) die("invalid count");
  size_t result = 0;
  for (; *value; value++) {
    if (!isdigit((unsigned char)*value)) die("invalid count");
    size_t digit = (size_t)(*value - '0');
    if (result > (maximum - digit) / 10) die("count overflow");
    result = result * 10 + digit;
  }
  return result;
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

static char *text_hex(char **cursor, const char *key, size_t maximum, int empty_ok) {
  size_t length;
  unsigned char *value = unhex(line(cursor, key), maximum, &length);
  if ((!empty_ok && !length) || (length && !valid_utf8(value, length))) die("invalid bounded UTF-8");
  return (char *)value;
}

static void valid_path(const char *path, int empty_ok) {
  size_t length = strlen(path);
  if (!length && empty_ok) return;
  if (!length || length > MAX_PATH_BYTES || path[0] == '/' || strchr(path, '\\') || strstr(path, "//")) die("unsafe path");
  if (!((length >= 3 && !strcmp(path + length - 3, ".md")) ||
        (length >= 4 && !strcmp(path + length - 4, ".org")))) die("unsupported file extension");
  char *copy = xstrdup(path), *save = NULL, *part = strtok_r(copy, "/", &save);
  size_t count = 0;
  while (part) {
    if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) die("path traversal");
    count++;
    part = strtok_r(NULL, "/", &save);
  }
  free(copy);
  if (!count) die("invalid path");
}

static Request parse(void) {
  unsigned char *raw;
  size_t raw_length;
  read_all(&raw, &raw_length);
  (void)raw_length;
  char *cursor = (char *)raw;
  Request request = {0};
  if (strcmp(line(&cursor, "MAGIC"), "F28WT1")) die("bad protocol magic");
  copy_text(request.command, sizeof request.command, line(&cursor, "COMMAND"), "bad command");
  size_t root_length;
  unsigned char *root = unhex(line(&cursor, "ROOTHEX"), sizeof(ROOT) - 1, &root_length);
  if (root_length != strlen(ROOT) || memcmp(root, ROOT, root_length)) die("root mismatch");
  free(root);
  copy_text(request.run, sizeof request.run, line(&cursor, "RUN"), "bad run");
  copy_text(request.kase, sizeof request.kase, line(&cursor, "CASE"), "bad case");
  copy_text(request.owner, sizeof request.owner, line(&cursor, "OWNER"), "bad owner");
  copy_text(request.workdir, sizeof request.workdir, line(&cursor, "WORKDIR"), "bad work directory");
  copy_text(request.metadir, sizeof request.metadir, line(&cursor, "METADIR"), "bad metadata directory");
  copy_text(request.basis_gen, sizeof request.basis_gen, line(&cursor, "BASISGEN"), "bad basis generation");
  copy_text(request.target_gen, sizeof request.target_gen, line(&cursor, "TARGETGEN"), "bad target generation");
  copy_text(request.preview, sizeof request.preview, line(&cursor, "PREVIEW"), "bad preview");
  copy_text(request.plan, sizeof request.plan, line(&cursor, "PLAN"), "bad plan");
  copy_text(request.tx, sizeof request.tx, line(&cursor, "TX"), "bad transaction");
  copy_text(request.failure, sizeof request.failure, line(&cursor, "FAILURE"), "bad failure");
  request.op_count = number(line(&cursor, "OPCOUNT"), MAX_ACTIONS);
  request.ops = xmalloc(sizeof(char *) * request.op_count);
  for (size_t index = 0; index < request.op_count; index++) {
    request.ops[index] = text_hex(&cursor, "OPHEX", 256, 0);
    if (!safe_component(request.ops[index])) die("unsafe operation identity");
  }
  request.action_count = number(line(&cursor, "ACTIONCOUNT"), MAX_ACTIONS);
  request.actions = xmalloc(sizeof(Action) * request.action_count);
  for (size_t index = 0; index < request.action_count; index++) {
    Action *action = &request.actions[index];
    memset(action, 0, sizeof *action);
    copy_text(action->kind, sizeof action->kind, line(&cursor, "KIND"), "bad action kind");
    action->file_id = text_hex(&cursor, "FILEIDHEX", 256, 0);
    action->old_path = text_hex(&cursor, "OLDPATHHEX", MAX_PATH_BYTES, 1);
    action->old_data = (unsigned char *)text_hex(&cursor, "OLDCONTENTHEX", MAX_CONTENT, 1);
    action->old_len = strlen((char *)action->old_data);
    action->new_path = text_hex(&cursor, "NEWPATHHEX", MAX_PATH_BYTES, 1);
    action->new_data = (unsigned char *)text_hex(&cursor, "NEWCONTENTHEX", MAX_CONTENT, 1);
    action->new_len = strlen((char *)action->new_data);
    sha256(action->old_data, action->old_len, action->old_hash);
    sha256(action->new_data, action->new_len, action->new_hash);
    if (!safe_component(action->file_id)) die("unsafe file identity");
    valid_path(action->old_path, 1);
    valid_path(action->new_path, 1);
    int create = !strcmp(action->kind, "create"), update = !strcmp(action->kind, "update");
    int rename_action = !strcmp(action->kind, "rename"), delete_action = !strcmp(action->kind, "delete");
    if (!(create || update || rename_action || delete_action)) die("unknown action kind");
    if ((create && (*action->old_path || !*action->new_path)) ||
        (update && (!*action->old_path || strcmp(action->old_path, action->new_path))) ||
        (rename_action && (!*action->old_path || !*action->new_path || strcmp((char *)action->old_data, (char *)action->new_data))) ||
        (delete_action && (!*action->old_path || *action->new_path))) die("inconsistent action fields");
  }
  request.base_state = unhex(line(&cursor, "BASESTATEHEX"), 8u * 1024u * 1024u, &request.base_state_len);
  request.state = unhex(line(&cursor, "STATEHEX"), 8u * 1024u * 1024u, &request.state_len);
  if ((request.base_state_len && !valid_utf8(request.base_state, request.base_state_len)) ||
      (request.state_len && !valid_utf8(request.state, request.state_len))) die("state is not bounded UTF-8");
  if (strcmp(line(&cursor, "END"), "1") || *cursor) die("trailing protocol data");
  if (strcmp(request.command, "initialize") && strcmp(request.command, "preflight") &&
      strcmp(request.command, "apply") && strcmp(request.command, "inspect")) die("unknown command");
  if (!safe_component(request.run) || !safe_component(request.kase) || !safe_component(request.workdir) ||
      !safe_component(request.metadir) || !strcmp(request.workdir, request.metadir) ||
      !strcmp(request.workdir, ".f28-sync") || !strcmp(request.metadir, ".f28-sync") ||
      !hex64(request.owner) || !hex64(request.basis_gen) || !hex64(request.target_gen) ||
      !fingerprint(request.preview) || !safe_component(request.plan) || !hex64(request.tx)) die("unsafe request identity");
  const char *failures[] = {"none", "during-stage", "after-action-1", "pause-before-action-2", "before-metadata", "after-metadata", "during-synchronization", "before-ack"};
  int known = 0;
  for (size_t index = 0; index < sizeof failures / sizeof failures[0]; index++)
    if (!strcmp(request.failure, failures[index])) known = 1;
  if (!known) die("unknown failure point");
  if (request.op_count != request.action_count && strcmp(request.command, "initialize")) die("operation/action count mismatch");
  for (size_t i = 0; i < request.op_count; i++) for (size_t j = 0; j < i; j++)
    if (!strcmp(request.ops[i], request.ops[j])) die("duplicate operation identity");
  return request;
}

static int open_directory(int parent, const char *name) {
  int descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) die("directory open refused");
  struct stat status;
  if (fstat(descriptor, &status) || !S_ISDIR(status.st_mode)) die("not directory");
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

static void identity_path(int parent, const char *name, dev_t device, ino_t inode) {
  int descriptor = open_directory(parent, name);
  dev_t actual_device;
  ino_t actual_inode;
  identity(descriptor, &actual_device, &actual_inode);
  close(descriptor);
  if (device != actual_device || inode != actual_inode) die("directory identity changed");
}

static int root_descriptor(void) {
  int descriptor = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (descriptor < 0) die("root open failed");
  char copy[sizeof ROOT];
  strcpy(copy, ROOT);
  char *save = NULL, *part = strtok_r(copy, "/", &save);
  while (part) {
    int next = open_directory(descriptor, part);
    close(descriptor);
    descriptor = next;
    part = strtok_r(NULL, "/", &save);
  }
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

static void exclusive_file(int parent, const char *name, const void *data, size_t length) {
  int descriptor = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) die("exclusive file creation refused");
  write_all(descriptor, data, length);
  full_sync(descriptor);
  if (close(descriptor)) die("close failed");
}

static unsigned char *read_file(int parent, const char *name, size_t maximum, size_t *length) {
  int descriptor = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) die("file open refused");
  struct stat status;
  if (fstat(descriptor, &status) || !S_ISREG(status.st_mode) || status.st_size < 0 || (uint64_t)status.st_size > maximum) die("invalid regular file");
  size_t total = (size_t)status.st_size, remaining = total;
  unsigned char *data = xmalloc(total + 1), *cursor = data;
  while (remaining) {
    ssize_t amount = read(descriptor, cursor, remaining);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) die("short read");
    cursor += amount;
    remaining -= (size_t)amount;
  }
  if (close(descriptor)) die("close failed");
  data[total] = 0;
  *length = total;
  return data;
}

static int file_parent(int root, const char *path, char **leaf, int create) {
  char *copy = xstrdup(path), *slash = strrchr(copy, '/');
  int descriptor = dup(root);
  if (descriptor < 0) die("dup failed");
  if (!slash) {
    *leaf = xstrdup(copy);
    free(copy);
    return descriptor;
  }
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

static int path_absent(int root, const char *path) {
  char *leaf;
  int parent;
  char *copy = xstrdup(path), *slash = strrchr(copy, '/');
  if (slash) {
    *slash = 0;
    char *save = NULL, *part = strtok_r(copy, "/", &save);
    parent = dup(root);
    if (parent < 0) die("dup failed");
    while (part) {
      if (!present(parent, part)) { close(parent); free(copy); return 1; }
      int next = open_directory(parent, part);
      close(parent);
      parent = next;
      part = strtok_r(NULL, "/", &save);
    }
    leaf = xstrdup(slash + 1);
  } else {
    parent = dup(root);
    leaf = xstrdup(copy);
  }
  int absent = !present(parent, leaf);
  close(parent);
  free(leaf);
  free(copy);
  return absent;
}

static int path_matches(int root, const char *path, const unsigned char *expected, size_t expected_length) {
  if (path_absent(root, path)) return 0;
  char *leaf;
  int parent = file_parent(root, path, &leaf, 0);
  size_t length;
  unsigned char *actual = read_file(parent, leaf, MAX_CONTENT, &length);
  int matches = length == expected_length && !memcmp(actual, expected, length);
  free(actual);
  free(leaf);
  close(parent);
  return matches;
}

static int entry_matches(int parent, const char *name,
                         const unsigned char *expected,
                         size_t expected_length) {
  if (!present(parent, name)) return 0;
  size_t length;
  unsigned char *actual = read_file(parent, name, MAX_CONTENT, &length);
  int matches = length == expected_length && !memcmp(actual, expected, length);
  free(actual);
  return matches;
}

static void verify_owner(int directory, const char *owner, const char *message) {
  char expected[132];
  int expected_length = snprintf(expected, sizeof expected, "%s\n", owner);
  size_t actual_length;
  unsigned char *actual = read_file(directory, "OWNER", sizeof expected, &actual_length);
  if (actual_length != (size_t)expected_length || memcmp(actual, expected, actual_length)) die(message);
  free(actual);
}

static void inject(Request *request, const char *point) {
  if (!strcmp(request->failure, point)) {
    fprintf(stderr, "INJECTED: %s\n", point);
    exit(25);
  }
}

static char *journal(Request *request) {
  size_t capacity = 8192 + request->action_count * (MAX_PATH_BYTES * 4 + 512) + request->op_count * 600;
  char *output = xmalloc(capacity);
  char base_hash[65], state_hash[65];
  sha256(request->base_state, request->base_state_len, base_hash);
  sha256(request->state, request->state_len, state_hash);
  size_t used = (size_t)snprintf(output, capacity,
      "F28WTJ1\nTX %s\nPREVIEW %s\nBASISGEN %s\nTARGETGEN %s\nPLAN %s\nBASESTATE %s\nSTATE %s\nOPCOUNT %zu\n",
      request->tx, request->preview, request->basis_gen, request->target_gen, request->plan,
      base_hash, state_hash, request->op_count);
  for (size_t index = 0; index < request->op_count; index++) {
    used += (size_t)snprintf(output + used, capacity - used, "OP %s\n", request->ops[index]);
  }
  used += (size_t)snprintf(output + used, capacity - used, "ACTIONCOUNT %zu\n", request->action_count);
  for (size_t index = 0; index < request->action_count; index++) {
    Action *action = &request->actions[index];
    char old_path_hash[65], new_path_hash[65];
    sha256(action->old_path, strlen(action->old_path), old_path_hash);
    sha256(action->new_path, strlen(action->new_path), new_path_hash);
    used += (size_t)snprintf(output + used, capacity - used,
        "ACTION %zu %s %s %s %s %s %s\n", index, action->kind, action->file_id,
        old_path_hash, action->old_hash, new_path_hash, action->new_hash);
    if (used >= capacity) die("journal overflow");
  }
  (void)snprintf(output + used, capacity - used, "PREPARED\n");
  return output;
}

static void verify_exact_file(int parent, const char *name, const unsigned char *expected, size_t expected_length, const char *message) {
  size_t actual_length;
  unsigned char *actual = read_file(parent, name, 8u * 1024u * 1024u, &actual_length);
  if (actual_length != expected_length || memcmp(actual, expected, actual_length)) die(message);
  free(actual);
}

static void marker_name(char output[96], const char *tx, size_t index) {
  (void)snprintf(output, 96, "%s.%03zu.done", tx, index);
}

static void verify_stage(int stage, int recovery, Request *request) {
  for (size_t index = 0; index < request->action_count; index++) {
    Action *action = &request->actions[index];
    char name[32];
    if (strcmp(action->kind, "create")) {
      (void)snprintf(name, sizeof name, "%03zu.before", index);
      verify_exact_file(stage, name, action->old_data, action->old_len,
                        "staged before-image mismatch");
    }
    if (strcmp(action->kind, "delete") && strcmp(action->kind, "rename")) {
      (void)snprintf(name, sizeof name, "%03zu.new", index);
      verify_exact_file(stage, name, action->new_data, action->new_len,
                        "staged intended content mismatch");
    }
  }
  verify_exact_file(recovery, "metadata.before", request->base_state,
                    request->base_state_len,
                    "retained metadata before-image mismatch");
}

static int before_state(int working, int recovery, Action *action, size_t index) {
  if (!strcmp(action->kind, "create")) return path_absent(working, action->new_path);
  if (!path_matches(working, action->old_path, action->old_data, action->old_len)) return 0;
  if (!strcmp(action->kind, "rename") && !path_absent(working, action->new_path)) return 0;
  if (!strcmp(action->kind, "delete")) {
    char deleted[32];
    (void)snprintf(deleted, sizeof deleted, "%03zu.deleted", index);
    if (present(recovery, deleted)) return 0;
  }
  return 1;
}

static int after_state(int working, int recovery, Action *action, size_t index) {
  if (!strcmp(action->kind, "create") || !strcmp(action->kind, "update"))
    return path_matches(working, action->new_path, action->new_data, action->new_len);
  if (!strcmp(action->kind, "rename"))
    return path_absent(working, action->old_path) && path_matches(working, action->new_path, action->new_data, action->new_len);
  char deleted[32];
  (void)snprintf(deleted, sizeof deleted, "%03zu.deleted", index);
  return path_absent(working, action->old_path) &&
         entry_matches(recovery, deleted, action->old_data, action->old_len);
}

static void apply_action(int working, int recovery, Request *request, size_t index) {
  Action *action = &request->actions[index];
  if (!strcmp(action->kind, "rename")) {
    char *old_leaf, *new_leaf;
    int old_parent = file_parent(working, action->old_path, &old_leaf, 0);
    int new_parent = file_parent(working, action->new_path, &new_leaf, 1);
    if (renameatx_np(old_parent, old_leaf, new_parent, new_leaf, RENAME_EXCL)) die("exclusive rename refused");
    sync_directory(old_parent);
    if (old_parent != new_parent) sync_directory(new_parent);
    free(old_leaf); free(new_leaf); close(old_parent); close(new_parent);
    return;
  }
  if (!strcmp(action->kind, "delete")) {
    char *old_leaf;
    int old_parent = file_parent(working, action->old_path, &old_leaf, 0);
    char deleted[32];
    (void)snprintf(deleted, sizeof deleted, "%03zu.deleted", index);
    if (renameatx_np(old_parent, old_leaf, recovery, deleted, RENAME_EXCL)) die("delete recovery move refused");
    sync_directory(old_parent); sync_directory(recovery);
    free(old_leaf); close(old_parent);
    return;
  }
  char *leaf;
  int parent = file_parent(working, action->new_path, &leaf, 1);
  char pending[96];
  (void)snprintf(pending, sizeof pending, ".f28-%.*s-%03zu.pending", 16, request->tx, index);
  exclusive_file(parent, pending, action->new_data, action->new_len);
  if (!strcmp(action->kind, "create")) {
    if (renameatx_np(parent, pending, parent, leaf, RENAME_EXCL)) die("exclusive create publication refused");
  } else if (renameat(parent, pending, parent, leaf)) die("update publication refused");
  sync_directory(parent);
  free(leaf); close(parent);
}

static void verify_all_after(int working, int recovery, Request *request) {
  for (size_t index = 0; index < request->action_count; index++)
    if (!after_state(working, recovery, &request->actions[index], index)) die("working result mismatch");
}

static void verify_target_generation(int sync, Request *request) {
  size_t length;
  unsigned char *current = read_file(sync, "CURRENT", 80, &length);
  if (length != 65 || current[64] != '\n' || memcmp(current, request->target_gen, 64)) die("target generation not selected");
  free(current);
  int generations = open_directory(sync, "generations");
  int generation = open_directory(generations, request->target_gen);
  unsigned char *manifest = read_file(generation, "manifest.txt", 4u * 1024u * 1024u, &length);
  char state_hash[65], needle[300];
  sha256(request->state, request->state_len, state_hash);
  (void)snprintf(needle, sizeof needle, "\nSELECTED %s\n", request->basis_gen);
  if (!strstr((char *)manifest, needle)) die("generation basis mismatch");
  (void)snprintf(needle, sizeof needle, "\nPLAN %s\n", request->plan);
  if (!strstr((char *)manifest, needle)) die("generation plan mismatch");
  (void)snprintf(needle, sizeof needle, "\nSTATEHASH %s\n", state_hash);
  if (!strstr((char *)manifest, needle)) die("generation state mismatch");
  free(manifest); close(generation); close(generations);
}

static void verify_initial_generation(int sync, Request *request) {
  size_t length;
  unsigned char *current = read_file(sync, "CURRENT", 80, &length);
  if (length != 65 || current[64] != '\n' ||
      memcmp(current, request->basis_gen, 64) ||
      strcmp(request->basis_gen, request->target_gen))
    die("initial generation mismatch");
  free(current);
  int generations = open_directory(sync, "generations");
  int generation = open_directory(generations, request->basis_gen);
  verify_exact_file(generation, "state.json", request->state,
                    request->state_len, "initial state mismatch");
  unsigned char *manifest =
      read_file(generation, "manifest.txt", 4u * 1024u * 1024u, &length);
  char *count_row = strstr((char *)manifest, "\nFILECOUNT ");
  if (!count_row) die("initial manifest file count missing");
  char *end = NULL;
  unsigned long count = strtoul(count_row + 11, &end, 10);
  if (end == count_row + 11 || *end != '\n' ||
      count != (unsigned long)request->action_count)
    die("initial manifest/action count mismatch");
  for (size_t index = 0; index < request->action_count; index++) {
    Action *action = &request->actions[index];
    if (strcmp(action->kind, "create") ||
        !path_matches(generation, action->new_path, action->new_data,
                      action->new_len))
      die("initial materialized file mismatch");
  }
  free(manifest);
  close(generation);
  close(generations);
}

int main(void) {
  Request request = parse();
  int root = root_descriptor();
  int run = open_directory(root, request.run);
  verify_owner(run, request.owner, "run ownership refused");
  int kase = open_directory(run, request.kase);
  verify_owner(kase, request.owner, "case ownership refused");
  dev_t run_device, case_device;
  ino_t run_inode, case_inode;
  identity(run, &run_device, &run_inode); identity(kase, &case_device, &case_inode);
  int sync = open_directory(kase, ".f28-sync");
  int lock = openat(sync, "LOCK", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB)) die("existing cooperative lock refused");
  struct stat lock_open, lock_path;
  if (fstat(lock, &lock_open) || !S_ISREG(lock_open.st_mode) ||
      fstatat(sync, "LOCK", &lock_path, AT_SYMLINK_NOFOLLOW) ||
      lock_open.st_dev != lock_path.st_dev || lock_open.st_ino != lock_path.st_ino) die("lock inode changed");

  if (!strcmp(request.command, "initialize")) {
    verify_initial_generation(sync, &request);
    if (present(kase, request.workdir) || present(kase, request.metadir)) die("working initialization already exists or is partial");
    if (mkdirat(kase, request.workdir, 0700) || mkdirat(kase, request.metadir, 0700)) die("working initialization mkdir refused");
    int working = open_directory(kase, request.workdir), metadata = open_directory(kase, request.metadir);
    int staging = make_directory(metadata, "staging"), journals = make_directory(metadata, "journals"), recovery = make_directory(metadata, "recovery");
    close(staging); close(journals); close(recovery);
    for (size_t index = 0; index < request.action_count; index++) {
      Action *action = &request.actions[index];
      if (strcmp(action->kind, "create")) die("initial state must contain creates only");
      char *leaf;
      int parent = file_parent(working, action->new_path, &leaf, 1);
      exclusive_file(parent, leaf, action->new_data, action->new_len);
      sync_directory(parent); free(leaf); close(parent);
    }
    exclusive_file(metadata, "accepted.json", request.state, request.state_len);
    sync_directory(working); sync_directory(metadata); sync_directory(kase);
    printf("STATUS initialized\nWORKDIR %s\nMETADIR %s\n", request.workdir, request.metadir);
    return 0;
  }

  int working = open_directory(kase, request.workdir), metadata = open_directory(kase, request.metadir);
  int staging = open_directory(metadata, "staging"), journals = open_directory(metadata, "journals"), recovery_root = open_directory(metadata, "recovery");
  dev_t working_device, metadata_device;
  ino_t working_inode, metadata_inode;
  identity(working, &working_device, &working_inode); identity(metadata, &metadata_device, &metadata_inode);

  if (!strcmp(request.command, "inspect")) {
    verify_exact_file(metadata, "accepted.json", request.state, request.state_len, "accepted metadata mismatch");
    puts("STATUS inspected");
    return 0;
  }

  size_t metadata_length;
  unsigned char *accepted = read_file(metadata, "accepted.json", 8u * 1024u * 1024u, &metadata_length);
  int metadata_before = metadata_length == request.base_state_len && !memcmp(accepted, request.base_state, metadata_length);
  int metadata_after = metadata_length == request.state_len && !memcmp(accepted, request.state, metadata_length);
  free(accepted);

  if (!strcmp(request.command, "preflight")) {
    char preflight_journal_name[80];
    (void)snprintf(preflight_journal_name, sizeof preflight_journal_name, "%s.journal", request.tx);
    if (present(journals, preflight_journal_name)) {
      char *expected_journal = journal(&request);
      verify_exact_file(journals, preflight_journal_name,
                        (unsigned char *)expected_journal,
                        strlen(expected_journal), "journal/request mismatch");
      free(expected_journal);
      int preflight_recovery = open_directory(recovery_root, request.tx);
      if (!metadata_before && !metadata_after) die("accepted metadata is in third state");
      for (size_t index = 0; index < request.action_count; index++)
        if (!before_state(working, preflight_recovery, &request.actions[index], index) &&
            !after_state(working, preflight_recovery, &request.actions[index], index))
          die("working file is in third state");
      close(preflight_recovery);
    } else {
      if (!metadata_before) die("stale accepted metadata");
      for (size_t index = 0; index < request.action_count; index++)
        if (!before_state(working, recovery_root, &request.actions[index], index)) die("stale working precondition");
    }
    identity_path(root, request.run, run_device, run_inode);
    identity_path(run, request.kase, case_device, case_inode);
    identity_path(kase, request.workdir, working_device, working_inode);
    identity_path(kase, request.metadir, metadata_device, metadata_inode);
    puts("STATUS ready");
    return 0;
  }

  verify_target_generation(sync, &request);
  char journal_name[80];
  (void)snprintf(journal_name, sizeof journal_name, "%s.journal", request.tx);
  char *journal_data = journal(&request);
  size_t journal_length = strlen(journal_data);
  int stage, recovery;
  if (present(journals, journal_name)) {
    verify_exact_file(journals, journal_name, (unsigned char *)journal_data, journal_length, "journal/request mismatch");
    stage = open_directory(staging, request.tx);
    recovery = open_directory(recovery_root, request.tx);
  } else {
    if (!metadata_before) die("stale accepted metadata before prepare");
    if (mkdirat(staging, request.tx, 0700) || mkdirat(recovery_root, request.tx, 0700)) die("transaction directory create refused");
    stage = open_directory(staging, request.tx); recovery = open_directory(recovery_root, request.tx);
    for (size_t index = 0; index < request.action_count; index++) {
      Action *action = &request.actions[index];
      char name[32];
      if (strcmp(action->kind, "create")) {
        (void)snprintf(name, sizeof name, "%03zu.before", index);
        exclusive_file(stage, name, action->old_data, action->old_len);
      }
      if (strcmp(action->kind, "delete") && strcmp(action->kind, "rename")) {
        (void)snprintf(name, sizeof name, "%03zu.new", index);
        exclusive_file(stage, name, action->new_data, action->new_len);
      }
      if (index == 0) inject(&request, "during-stage");
    }
    exclusive_file(recovery, "metadata.before", request.base_state, request.base_state_len);
    sync_directory(stage); sync_directory(recovery); sync_directory(staging); sync_directory(recovery_root);
    exclusive_file(journals, journal_name, journal_data, journal_length);
    sync_directory(journals); sync_directory(metadata);
  }
  free(journal_data);
  verify_stage(stage, recovery, &request);

  char ack_name[80];
  (void)snprintf(ack_name, sizeof ack_name, "%s.ack", request.tx);
  if (present(journals, ack_name)) {
    verify_exact_file(journals, ack_name,
                      (unsigned char *)"acknowledged\n", 13,
                      "acknowledgement mismatch");
    verify_stage(stage, recovery, &request);
    verify_all_after(working, recovery, &request);
    if (!metadata_after) die("acknowledged metadata changed");
    verify_target_generation(sync, &request);
    puts("STATUS already-applied");
    return 0;
  }

  for (size_t index = 0; index < request.action_count; index++) {
    char marker[96];
    marker_name(marker, request.tx, index);
    int after = after_state(working, recovery, &request.actions[index], index);
    int before = before_state(working, recovery, &request.actions[index], index);
    if (present(journals, marker)) {
      verify_exact_file(journals, marker, (unsigned char *)"done\n", 5,
                        "action marker mismatch");
      if (!after) die("completed action is no longer in after state");
      continue;
    }
    if (after) {
      exclusive_file(journals, marker, "done\n", 5); sync_directory(journals);
      continue;
    }
    if (!before) die("working file is in third state");
    if (index == 1 && !strcmp(request.failure, "pause-before-action-2")) {
      puts("HOOK pause-before-action-2"); fflush(stdout); sleep(2);
      if (!before_state(working, recovery, &request.actions[index], index)) die("working file changed during action pause");
    }
    apply_action(working, recovery, &request, index);
    if (!after_state(working, recovery, &request.actions[index], index)) die("action verification failed");
    exclusive_file(journals, marker, "done\n", 5); sync_directory(journals);
    if (index == 0) inject(&request, "after-action-1");
  }
  verify_all_after(working, recovery, &request);
  inject(&request, "before-metadata");
  char metadata_marker[80];
  (void)snprintf(metadata_marker, sizeof metadata_marker, "%s.metadata", request.tx);
  if (!present(journals, metadata_marker)) {
    if (!metadata_before && !metadata_after) die("accepted metadata is in third state");
    if (metadata_before) {
      char pending[80];
      (void)snprintf(pending, sizeof pending, "accepted.%.*s.pending", 32, request.tx);
      exclusive_file(metadata, pending, request.state, request.state_len);
      if (renameat(metadata, pending, metadata, "accepted.json")) die("metadata publication failed");
      inject(&request, "during-synchronization");
      sync_directory(metadata);
    }
    verify_exact_file(metadata, "accepted.json", request.state, request.state_len, "projected metadata mismatch");
    exclusive_file(journals, metadata_marker, "accepted\n", 9); sync_directory(journals);
  } else
    verify_exact_file(journals, metadata_marker,
                      (unsigned char *)"accepted\n", 9,
                      "metadata marker mismatch");
  inject(&request, "after-metadata");
  verify_all_after(working, recovery, &request);
  verify_exact_file(metadata, "accepted.json", request.state, request.state_len, "projected metadata mismatch");
  char *final_journal = journal(&request);
  verify_exact_file(journals, journal_name, (unsigned char *)final_journal,
                    strlen(final_journal), "journal/request mismatch");
  free(final_journal);
  verify_stage(stage, recovery, &request);
  identity_path(root, request.run, run_device, run_inode);
  identity_path(run, request.kase, case_device, case_inode);
  identity_path(kase, request.workdir, working_device, working_inode);
  identity_path(kase, request.metadir, metadata_device, metadata_inode);
  if (fstatat(sync, "LOCK", &lock_path, AT_SYMLINK_NOFOLLOW) || lock_open.st_dev != lock_path.st_dev || lock_open.st_ino != lock_path.st_ino) die("lock inode changed before acknowledgement");
  inject(&request, "before-ack");
  exclusive_file(journals, ack_name, "acknowledged\n", 13);
  sync_directory(journals); sync_directory(metadata);
  verify_exact_file(journals, ack_name, (unsigned char *)"acknowledged\n", 13, "acknowledgement mismatch");
  puts("STATUS acknowledged");
  return 0;
}
