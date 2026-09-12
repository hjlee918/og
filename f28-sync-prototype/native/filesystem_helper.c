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
#define ROOT                                                                   \
  "/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test"
#define MAX_INPUT (16u * 1024u * 1024u)
#define MAX_FILES 128u
#define MAX_PATH_BYTES 1024u
#define MAX_CONTENT (1024u * 1024u)
#define MAX_READ_PAYLOAD (8u * 1024u * 1024u)
typedef struct {
  char *path;
  unsigned char *data;
  size_t len;
  char hash[65];
} File;
typedef struct {
  char command[16], run[96], kase[96], owner[129], basis[72], projected[72],
      plan[129], tx[65], failure[40];
  unsigned char *state;
  size_t state_len;
  char **ops;
  size_t op_count;
  File *files;
  size_t file_count;
} Request;
static void die(const char *m) {
  fprintf(stderr, "REFUSED: %s (errno=%d)\n", m, errno);
  exit(23);
}
static void *xmalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p)
    die("allocation failed");
  return p;
}
static void sha256(const void *d, size_t n, char out[65]) {
  unsigned char h[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(d, (CC_LONG)n, h);
  for (int i = 0; i < 32; i++)
    snprintf(out + i * 2, 3, "%02x", h[i]);
  out[64] = 0;
}
static int hexv(char c) {
  if (c >= '0' && c <= '9')
    return c - '0';
  if (c >= 'a' && c <= 'f')
    return c - 'a' + 10;
  if (c >= 'A' && c <= 'F')
    return c - 'A' + 10;
  return -1;
}
static unsigned char *unhex(const char *s, size_t max, size_t *out) {
  size_t n = strlen(s);
  if ((n & 1) || n / 2 > max)
    die("invalid hex length");
  unsigned char *p = xmalloc(n / 2 + 1);
  for (size_t i = 0; i < n; i += 2) {
    int a = hexv(s[i]), b = hexv(s[i + 1]);
    if (a < 0 || b < 0)
      die("invalid hex");
    p[i / 2] = (unsigned char)(a * 16 + b);
  }
  p[n / 2] = 0;
  *out = n / 2;
  return p;
}
static int safe_component(const char *s) {
  size_t n = strlen(s);
  if (!n || n > 80)
    return 0;
  for (size_t i = 0; i < n; i++)
    if (!isalnum((unsigned char)s[i]) && s[i] != '_' && s[i] != '-')
      return 0;
  return strcmp(s, ".") && strcmp(s, "..");
}
static int hex64(const char *s) {
  if (strlen(s) != 64)
    return 0;
  for (int i = 0; i < 64; i++)
    if (hexv(s[i]) < 0)
      return 0;
  return 1;
}
static int valid_utf8(const unsigned char *s, size_t n) {
  for (size_t i = 0; i < n;) {
    unsigned char c = s[i++];
    if (c == 0)
      return 0;
    if (c < 0x80)
      continue;
    unsigned need = c >= 0xC2 && c <= 0xDF ? 1 : c >= 0xE0 && c <= 0xEF ? 2 : c >= 0xF0 && c <= 0xF4 ? 3 : 99;
    if (need == 99 || i + need > n)
      return 0;
    unsigned char first = s[i];
    if ((c == 0xE0 && first < 0xA0) || (c == 0xED && first >= 0xA0) ||
        (c == 0xF0 && first < 0x90) || (c == 0xF4 && first >= 0x90))
      return 0;
    for (unsigned j = 0; j < need; j++)
      if ((s[i++] & 0xC0) != 0x80)
        return 0;
  }
  return 1;
}
static int fingerprint(const char *s) {
  return strlen(s) == 71 && !strncmp(s, "sha256:", 7) && hex64(s + 7);
}
static void read_all(unsigned char **out, size_t *len) {
  size_t cap = 4096, n = 0;
  unsigned char *p = xmalloc(cap);
  for (;;) {
    if (n == cap) {
      if (cap >= MAX_INPUT)
        die("protocol too large");
      cap *= 2;
      if (cap > MAX_INPUT)
        cap = MAX_INPUT;
      p = realloc(p, cap);
      if (!p)
        die("allocation failed");
    }
    ssize_t r = read(STDIN_FILENO, p + n, cap - n);
    if (r < 0) {
      if (errno == EINTR)
        continue;
      die("protocol read failed");
    }
    if (!r)
      break;
    n += (size_t)r;
  }
  for (size_t i = 0; i < n; i++)
    if (!p[i])
      die("embedded NUL refused");
  p = realloc(p, n + 1);
  if (!p)
    die("allocation failed");
  p[n] = 0;
  *out = p;
  *len = n;
}
static char *line(char **cursor, const char *key) {
  char *p = *cursor, *nl = strchr(p, '\n');
  if (!nl)
    die("truncated protocol");
  *nl = 0;
  size_t k = strlen(key);
  if (strncmp(p, key, k) || p[k] != '\t')
    die("unexpected protocol field");
  *cursor = nl + 1;
  return p + k + 1;
}
static size_t number(const char *s, size_t max) {
  if (!*s)
    die("invalid count");
  size_t v = 0;
  for (; *s; s++) {
    if (!isdigit((unsigned char)*s))
      die("invalid count");
    if (v > (max - (size_t)(*s - '0')) / 10)
      die("count overflow");
    v = v * 10 + (size_t)(*s - '0');
  }
  return v;
}
static void copy_text(char *d, size_t cap, const char *s, const char *label) {
  if (strlen(s) >= cap)
    die(label);
  strcpy(d, s);
}
static Request parse(void) {
  unsigned char *raw;
  size_t n;
  read_all(&raw, &n);
  (void)n;
  char *c = (char *)raw;
  Request r = {0};
  if (strcmp(line(&c, "MAGIC"), "F28FS1"))
    die("bad protocol magic");
  copy_text(r.command, sizeof r.command, line(&c, "COMMAND"), "bad command");
  size_t rn;
  unsigned char *rd = unhex(line(&c, "ROOTHEX"), sizeof(ROOT) - 1, &rn);
  if (rn != strlen(ROOT) || memcmp(rd, ROOT, rn))
    die("root mismatch");
  free(rd);
  copy_text(r.run, sizeof r.run, line(&c, "RUN"), "bad run");
  copy_text(r.kase, sizeof r.kase, line(&c, "CASE"), "bad case");
  copy_text(r.owner, sizeof r.owner, line(&c, "OWNER"), "bad owner");
  copy_text(r.basis, sizeof r.basis, line(&c, "BASIS"), "bad basis");
  copy_text(r.projected, sizeof r.projected, line(&c, "PROJECTED"),
            "bad projected");
  copy_text(r.plan, sizeof r.plan, line(&c, "PLAN"), "bad plan");
  copy_text(r.tx, sizeof r.tx, line(&c, "TX"), "bad tx");
  copy_text(r.failure, sizeof r.failure, line(&c, "FAILURE"), "bad failure");
  r.op_count = number(line(&c, "OPCOUNT"), MAX_FILES);
  r.ops = xmalloc(sizeof(char *) * r.op_count);
  for (size_t i = 0; i < r.op_count; i++) {
    size_t z;
    r.ops[i] = (char *)unhex(line(&c, "OPHEX"), 256, &z);
    if (!z || !valid_utf8((unsigned char *)r.ops[i], z))
      die("empty operation ID");
  }
  r.file_count = number(line(&c, "FILECOUNT"), MAX_FILES);
  r.files = xmalloc(sizeof(File) * r.file_count);
  for (size_t i = 0; i < r.file_count; i++) {
    size_t z;
    r.files[i].path = (char *)unhex(line(&c, "PATHHEX"), MAX_PATH_BYTES, &z);
    if (!z || memchr(r.files[i].path, 0, z))
      die("invalid path bytes");
    r.files[i].data =
        unhex(line(&c, "CONTENTHEX"), MAX_CONTENT, &r.files[i].len);
    if (!valid_utf8((unsigned char *)r.files[i].path, z) ||
        !valid_utf8(r.files[i].data, r.files[i].len))
      die("file path/content is not bounded UTF-8");
    sha256(r.files[i].data, r.files[i].len, r.files[i].hash);
  }
  r.state = unhex(line(&c, "STATEHEX"), 8u * 1024u * 1024u, &r.state_len);
  if (!valid_utf8(r.state, r.state_len))
    die("state is not bounded UTF-8");
  if (strcmp(line(&c, "END"), "1") || *c)
    die("trailing protocol data");
  if (!safe_component(r.run) || !safe_component(r.kase) ||
      strlen(r.owner) < 32 || !hex64(r.owner))
    die("unsafe ownership fields");
  if (!fingerprint(r.basis) || !fingerprint(r.projected))
    die("invalid state fingerprint");
  if (!safe_component(r.plan) || (strcmp(r.tx, "none") && !hex64(r.tx)))
    die("invalid plan or transaction identity");
  const char *allowed_failures[] = {
      "none", "during-staging", "before-prepared", "after-prepared",
      "after-generation-rename", "before-current-rename",
      "pause-before-final-basis", "pause-read-before-recheck",
      "during-synchronization",
      "after-current-rename", "before-ack"};
  int known_failure = 0;
  for (size_t i = 0; i < sizeof allowed_failures / sizeof allowed_failures[0]; i++)
    if (!strcmp(r.failure, allowed_failures[i]))
      known_failure = 1;
  if (!known_failure)
    die("unknown failure point");
  for (size_t i = 0; i < r.op_count; i++) {
    if (!safe_component(r.ops[i]))
      die("invalid operation identity");
    for (size_t j = 0; j < i; j++)
      if (!strcmp(r.ops[i], r.ops[j]))
        die("duplicate operation identity");
  }
  if (strcmp(r.command, "initialize") && strcmp(r.command, "apply") &&
      strcmp(r.command, "inspect") && strcmp(r.command, "hold") &&
      strcmp(r.command, "read-selected"))
    die("unknown command");
  return r;
}
static int odir(int p, const char *n) {
  int f = openat(p, n, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (f < 0)
    die("directory open refused");
  struct stat s;
  if (fstat(f, &s) || !S_ISDIR(s.st_mode))
    die("not directory");
  return f;
}
static int mdir(int p, const char *n, int *made) {
  if (mkdirat(p, n, 0700) == 0)
    *made = 1;
  else if (errno != EEXIST)
    die("mkdir failed");
  return odir(p, n);
}
static void syncdir(int fd) {
  int rc;
  do {
    rc = fsync(fd);
  } while (rc && errno == EINTR);
  if (rc)
    die("directory synchronization failed");
}
static void fullsync(int fd) {
  int rc;
  do {
    rc = fcntl(fd, F_FULLFSYNC);
  } while (rc && errno == EINTR);
  if (rc)
    die("required F_FULLFSYNC failed");
}
static void writeall(int fd, const void *p, size_t n) {
  size_t q = 0;
  while (q < n) {
    ssize_t w = write(fd, (const char *)p + q, n - q);
    if (w < 0 && errno == EINTR)
      continue;
    if (w <= 0)
      die("short write");
    q += (size_t)w;
  }
}
static void exclusive(int p, const char *n, const void *d, size_t z) {
  int f =
      openat(p, n, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (f < 0)
    die("exclusive file creation refused");
  writeall(f, d, z);
  fullsync(f);
  if (close(f))
    die("close failed");
}
static unsigned char *readfile(int p, const char *n, size_t max, size_t *z) {
  int f = openat(p, n, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (f < 0)
    die("file open refused");
  struct stat s;
  if (fstat(f, &s) || !S_ISREG(s.st_mode) || s.st_size < 0 ||
      (uint64_t)s.st_size > max)
    die("invalid regular file");
  size_t total = (size_t)s.st_size, left = total;
  unsigned char *b = xmalloc(total + 1), *q = b;
  while (left) {
    ssize_t x = read(f, q, left);
    if (x < 0 && errno == EINTR)
      continue;
    if (x <= 0)
      die("short read");
    q += x;
    left -= (size_t)x;
  }
  close(f);
  b[total] = 0;
  *z = total;
  return b;
}
static void identity(int fd, dev_t *d, ino_t *i) {
  struct stat s;
  if (fstat(fd, &s))
    die("identity failed");
  *d = s.st_dev;
  *i = s.st_ino;
}
static void identity_path(int p, const char *n, dev_t d, ino_t i) {
  int f = odir(p, n);
  dev_t x;
  ino_t y;
  identity(f, &x, &y);
  close(f);
  if (x != d || y != i)
    die("directory identity changed");
}
static int rootfd(void) {
  int f = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (f < 0)
    die("root open failed");
  char tmp[sizeof ROOT];
  strcpy(tmp, ROOT);
  char *save = NULL, *p = strtok_r(tmp, "/", &save);
  while (p) {
    int n = odir(f, p);
    close(f);
    f = n;
    p = strtok_r(NULL, "/", &save);
  }
  return f;
}
static int present(int p, const char *n) {
  struct stat s;
  if (!fstatat(p, n, &s, AT_SYMLINK_NOFOLLOW))
    return 1;
  if (errno == ENOENT)
    return 0;
  die("entry status failed");
  return 0;
}
static void valid_path(char *p) {
  size_t n = strlen(p);
  if (!n || n > MAX_PATH_BYTES || p[0] == '/' || strchr(p, '\\'))
    die("unsafe path");
  if (!((n >= 3 && !strcmp(p + n - 3, ".md")) ||
        (n >= 4 && !strcmp(p + n - 4, ".org"))))
    die("unsupported file extension");
  char *t = xmalloc(n + 1);
  strcpy(t, p);
  char *sv = NULL, *s = strtok_r(t, "/", &sv);
  size_t parts = 0;
  while (s) {
    if (!strcmp(s, ".") || !strcmp(s, "..") || !*s)
      die("path traversal");
    parts++;
    s = strtok_r(NULL, "/", &sv);
  }
  free(t);
  if (!parts || strstr(p, "//"))
    die("invalid path");
}
static int file_parent(int gen, char *p, char **leaf, int create) {
  char *t = xmalloc(strlen(p) + 1);
  strcpy(t, p);
  char *slash = strrchr(t, '/');
  int d = dup(gen);
  if (d < 0)
    die("dup failed");
  if (!slash) {
    *leaf = strdup(t);
    free(t);
    return d;
  }
  *slash = 0;
  *leaf = strdup(slash + 1);
  char *sv = NULL, *s = strtok_r(t, "/", &sv);
  while (s) {
    int made = 0, n = create ? mdir(d, s, &made) : odir(d, s);
    close(d);
    d = n;
    s = strtok_r(NULL, "/", &sv);
  }
  free(t);
  return d;
}
static char *manifest(Request *r) {
  size_t cap =
      4096 + r->file_count * (MAX_PATH_BYTES * 2 + 100) + r->op_count * 600;
  char *b = xmalloc(cap);
  size_t n = (size_t)snprintf(
      b, cap, "F28MAN1\nGEN %s\nBASIS %s\nPROJECTED %s\nPLAN %s\nSTATEHASH ",
      r->tx, r->basis, r->projected, r->plan);
  char h[65];
  sha256(r->state, r->state_len, h);
  n += (size_t)snprintf(b + n, cap - n, "%s\nOPCOUNT %zu\n", h, r->op_count);
  for (size_t i = 0; i < r->op_count; i++) {
    n += (size_t)snprintf(b + n, cap - n, "OPHEX ");
    for (char *p = r->ops[i]; *p; p++)
      n += (size_t)snprintf(b + n, cap - n, "%02x", (unsigned char)*p);
    n += (size_t)snprintf(b + n, cap - n, "\n");
  }
  n += (size_t)snprintf(b + n, cap - n, "FILECOUNT %zu\n", r->file_count);
  for (size_t i = 0; i < r->file_count; i++) {
    n += (size_t)snprintf(b + n, cap - n, "PATHHEX ");
    for (char *p = r->files[i].path; *p; p++)
      n += (size_t)snprintf(b + n, cap - n, "%02x", (unsigned char)*p);
    n += (size_t)snprintf(b + n, cap - n, " %s\n", r->files[i].hash);
  }
  snprintf(b + n, cap - n, "PREPARED\n");
  return b;
}
static void state_fp(Request *r) {
  char h[65], want[72];
  sha256(r->state, r->state_len, h);
  snprintf(want, sizeof want, "sha256:%s", h);
  if (strcmp(want, r->projected))
    die("projected state fingerprint mismatch");
}
static char *selector(int meta) {
  size_t n;
  unsigned char *b = readfile(meta, "CURRENT", 80, &n);
  if (n != 65 || b[64] != '\n') {
    free(b);
    die("unsafe CURRENT");
  }
  b[64] = 0;
  if (!hex64((char *)b))
    die("unsafe CURRENT");
  return (char *)b;
}
static void validate_pending_selector(int meta, const char *name,
                                      const char *transaction) {
  size_t n;
  unsigned char *value = readfile(meta, name, 80, &n);
  if (n != 65 || value[64] != '\n' ||
      memcmp(value, transaction, 64) || !hex64(transaction)) {
    free(value);
    die("pending selector mismatch");
  }
  free(value);
}
static void verify_gen(int gs, const char *dir, Request *expected) {
  int g = odir(gs, dir);
  size_t sn, mn;
  unsigned char *s = readfile(g, "state.json", 8u * 1024u * 1024u, &sn),
                *m = readfile(g, "manifest.txt", 4u * 1024u * 1024u, &mn);
  char sh[65];
  sha256(s, sn, sh);
  char *copy = xmalloc(mn + 1);
  memcpy(copy, m, mn);
  copy[mn] = 0;
  char expected_name[65];
  if (strlen(dir) == 72 && !strcmp(dir + 64, ".staging"))
    memcpy(expected_name, dir, 64);
  else if (strlen(dir) == 64)
    memcpy(expected_name, dir, 64);
  else
    die("unsafe generation directory name");
  expected_name[64] = 0;
  char generation_header[96];
  snprintf(generation_header, sizeof generation_header, "F28MAN1\nGEN %s\n",
           expected_name);
  if (strncmp(copy, generation_header, strlen(generation_header)) ||
      !strstr(copy, "\nPREPARED\n"))
    die("invalid manifest");
  char needle[256];
  snprintf(needle, sizeof needle, "\nSTATEHASH %s\n", sh);
  if (!strstr(copy, needle))
    die("state hash mismatch");
  snprintf(needle, sizeof needle, "\nPROJECTED sha256:%s\n", sh);
  if (!strstr(copy, needle))
    die("state/projected fingerprint mismatch");
  if (expected) {
    char *wanted = manifest(expected);
    if (strlen(wanted) != mn || memcmp(wanted, m, mn))
      die("manifest/request mismatch");
    free(wanted);
    snprintf(needle, sizeof needle, "\nPROJECTED %s\n", expected->projected);
    if (!strstr(copy, needle))
      die("projected mismatch");
    snprintf(needle, sizeof needle, "\nPLAN %s\n", expected->plan);
    if (!strstr(copy, needle))
      die("plan mismatch");
  }
  char *fc = strstr(copy, "\nFILECOUNT ");
  if (!fc)
    die("manifest file count missing");
  fc += 11;
  char *end = NULL;
  unsigned long count = strtoul(fc, &end, 10);
  if (end == fc || count > MAX_FILES || *end != '\n')
    die("invalid manifest file count");
  char *row = end + 1;
  for (unsigned long i = 0; i < count; i++) {
    if (strncmp(row, "PATHHEX ", 8))
      die("invalid manifest file row");
    char *space = strchr(row + 8, ' '), *nl = strchr(row, '\n');
    if (!space || !nl || space > nl || nl - space != 65)
      die("invalid manifest file row");
    *space = 0;
    size_t plen;
    char *path = (char *)unhex(row + 8, MAX_PATH_BYTES, &plen);
    (void)plen;
    valid_path(path);
    char *leaf;
    int p = file_parent(g, path, &leaf, 0);
    size_t z;
    unsigned char *d = readfile(p, leaf, MAX_CONTENT, &z);
    char h[65];
    sha256(d, z, h);
    if (strncmp(h, space + 1, 64))
      die("materialized file mismatch");
    free(d);
    free(leaf);
    free(path);
    close(p);
    row = nl + 1;
  }
  if (strcmp(row, "PREPARED\n"))
    die("manifest trailing data");
  if (expected && count != expected->file_count)
    die("manifest/request file count mismatch");
  free(s);
  free(m);
  free(copy);
  close(g);
}
static void inject(Request *r, const char *p) {
  if (!strcmp(r->failure, p)) {
    fprintf(stderr, "INJECTED: %s\n", p);
    exit(25);
  }
}
static void pause_before_final_basis(Request *r) {
  if (!strcmp(r->failure, "pause-before-final-basis")) {
    puts("HOOK pause-before-final-basis");
    fflush(stdout);
    sleep(2);
  }
}
static void print_hex(const unsigned char *data, size_t length) {
  static const char digits[] = "0123456789abcdef";
  char buffer[8192];
  size_t used = 0;
  for (size_t i = 0; i < length; i++) {
    buffer[used++] = digits[data[i] >> 4];
    buffer[used++] = digits[data[i] & 15];
    if (used == sizeof buffer) {
      if (fwrite(buffer, 1, used, stdout) != used)
        die("read response write failed");
      used = 0;
    }
  }
  if (used && fwrite(buffer, 1, used, stdout) != used)
    die("read response write failed");
}
static File *load_manifest_files(int generation, size_t *file_count,
                                 size_t *payload) {
  size_t manifest_length;
  unsigned char *manifest_data =
      readfile(generation, "manifest.txt", 4u * 1024u * 1024u,
               &manifest_length);
  char *cursor = strstr((char *)manifest_data, "\nFILECOUNT ");
  if (!cursor)
    die("manifest file count missing");
  cursor += 11;
  char *end = NULL;
  unsigned long count = strtoul(cursor, &end, 10);
  if (end == cursor || count > MAX_FILES || *end != '\n')
    die("invalid manifest file count");
  File *files = xmalloc(sizeof(File) * (size_t)count);
  cursor = end + 1;
  for (unsigned long i = 0; i < count; i++) {
    if (strncmp(cursor, "PATHHEX ", 8))
      die("invalid manifest file row");
    char *space = strchr(cursor + 8, ' '), *newline = strchr(cursor, '\n');
    if (!space || !newline || space > newline || newline - space != 65)
      die("invalid manifest file row");
    *space = 0;
    size_t path_length;
    files[i].path =
        (char *)unhex(cursor + 8, MAX_PATH_BYTES, &path_length);
    if (!valid_utf8((unsigned char *)files[i].path, path_length))
      die("invalid manifest path UTF-8");
    valid_path(files[i].path);
    char *leaf;
    int parent = file_parent(generation, files[i].path, &leaf, 0);
    files[i].data = readfile(parent, leaf, MAX_CONTENT, &files[i].len);
    close(parent);
    free(leaf);
    sha256(files[i].data, files[i].len, files[i].hash);
    if (strncmp(files[i].hash, space + 1, 64))
      die("materialized file mismatch");
    if (*payload > MAX_READ_PAYLOAD - path_length ||
        *payload + path_length > MAX_READ_PAYLOAD - files[i].len)
      die("read response exceeds bound");
    *payload += path_length + files[i].len;
    cursor = newline + 1;
  }
  free(manifest_data);
  *file_count = (size_t)count;
  return files;
}
static void emit_read_snapshot(const char *generation_name,
                               const unsigned char *state, size_t state_length,
                               File *files, size_t file_count) {
  printf("SCHEMA F28READ1\nGENERATION %s\nSTATEHEX ", generation_name);
  print_hex(state, state_length);
  printf("\nFILECOUNT %zu\n", file_count);
  for (size_t i = 0; i < file_count; i++) {
    printf("PATHHEX ");
    print_hex((unsigned char *)files[i].path, strlen(files[i].path));
    printf("\nCONTENTHEX ");
    print_hex(files[i].data, files[i].len);
    printf("\n");
  }
  printf("END 1\n");
  if (fflush(stdout))
    die("read response flush failed");
}
int main(void) {
  Request r = parse();
  state_fp(&r);
  int root = rootfd();
  if (!strcmp(r.command, "read-selected")) {
    int run = odir(root, r.run);
    dev_t run_dev;
    ino_t run_ino;
    identity(run, &run_dev, &run_ino);
    char owner[132];
    int owner_length = snprintf(owner, sizeof owner, "%s\n", r.owner);
    size_t actual_owner_length;
    unsigned char *actual_owner =
        readfile(run, "OWNER", sizeof owner, &actual_owner_length);
    if (actual_owner_length != (size_t)owner_length ||
        memcmp(actual_owner, owner, actual_owner_length))
      die("run ownership refused");
    free(actual_owner);
    int kase = odir(run, r.kase);
    dev_t case_dev;
    ino_t case_ino;
    identity(kase, &case_dev, &case_ino);
    actual_owner = readfile(kase, "OWNER", sizeof owner, &actual_owner_length);
    if (actual_owner_length != (size_t)owner_length ||
        memcmp(actual_owner, owner, actual_owner_length))
      die("case ownership refused");
    free(actual_owner);
    int meta = odir(kase, ".f28-sync"), generations = odir(meta, "generations");
    dev_t meta_dev, generations_dev;
    ino_t meta_ino, generations_ino;
    identity(meta, &meta_dev, &meta_ino);
    identity(generations, &generations_dev, &generations_ino);
    int lock = openat(meta, "LOCK", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (lock < 0 || flock(lock, LOCK_SH | LOCK_NB))
      die("existing read lock refused");
    struct stat lock_opened, lock_path;
    if (fstat(lock, &lock_opened) || !S_ISREG(lock_opened.st_mode) ||
        fstatat(meta, "LOCK", &lock_path, AT_SYMLINK_NOFOLLOW) ||
        lock_opened.st_dev != lock_path.st_dev ||
        lock_opened.st_ino != lock_path.st_ino)
      die("read lock inode changed");
    char *selected = selector(meta);
    verify_gen(generations, selected, NULL);
    int selected_fd = odir(generations, selected);
    size_t state_length, file_count, payload = 0;
    unsigned char *state = readfile(selected_fd, "state.json",
                                    MAX_READ_PAYLOAD, &state_length);
    payload = state_length;
    File *files = load_manifest_files(selected_fd, &file_count, &payload);
    close(selected_fd);
    if (!strcmp(r.failure, "pause-read-before-recheck")) {
      puts("HOOK pause-read-before-recheck");
      fflush(stdout);
      sleep(2);
    }
    char *selected_again = selector(meta);
    if (strcmp(selected, selected_again))
      die("CURRENT changed during read");
    free(selected_again);
    verify_gen(generations, selected, NULL);
    identity_path(root, r.run, run_dev, run_ino);
    identity_path(run, r.kase, case_dev, case_ino);
    identity_path(kase, ".f28-sync", meta_dev, meta_ino);
    identity_path(meta, "generations", generations_dev, generations_ino);
    if (fstatat(meta, "LOCK", &lock_path, AT_SYMLINK_NOFOLLOW) ||
        lock_opened.st_dev != lock_path.st_dev ||
        lock_opened.st_ino != lock_path.st_ino)
      die("read lock inode changed before response");
    emit_read_snapshot(selected, state, state_length, files, file_count);
    return 0;
  }
  int made = 0, run = mdir(root, r.run, &made);
  dev_t rd;
  ino_t ri;
  identity(run, &rd, &ri);
  char own[132];
  int oz = snprintf(own, sizeof own, "%s\n", r.owner);
  if (made) {
    exclusive(run, "OWNER", own, (size_t)oz);
    syncdir(run);
    syncdir(root);
  }
  size_t on;
  unsigned char *ob = readfile(run, "OWNER", sizeof own, &on);
  if (on != (size_t)oz || memcmp(ob, own, on))
    die("run ownership refused");
  free(ob);
  identity_path(root, r.run, rd, ri);
  int cmade = 0, kase = mdir(run, r.kase, &cmade);
  dev_t cd;
  ino_t ci;
  identity(kase, &cd, &ci);
  if (cmade) {
    exclusive(kase, "OWNER", own, (size_t)oz);
    syncdir(kase);
    syncdir(run);
  }
  ob = readfile(kase, "OWNER", sizeof own, &on);
  if (on != (size_t)oz || memcmp(ob, own, on))
    die("case ownership refused");
  free(ob);
  int x = 0, meta = mdir(kase, ".f28-sync", &x),
      gs = mdir(meta, "generations", &x);
  dev_t meta_dev, generations_dev;
  ino_t meta_ino, generations_ino;
  identity(meta, &meta_dev, &meta_ino);
  identity(gs, &generations_dev, &generations_ino);
  int lock =
      openat(meta, "LOCK", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB))
    die("another helper owns this case");
  struct stat ls, lp;
  if (fstat(lock, &ls) || fstatat(meta, "LOCK", &lp, AT_SYMLINK_NOFOLLOW) ||
      ls.st_ino != lp.st_ino || ls.st_dev != lp.st_dev)
    die("lock inode changed");
  if (!strcmp(r.command, "hold")) {
    sleep(30);
    puts("STATUS held");
    return 0;
  }
  if (!present(meta, "CURRENT")) {
    if (strcmp(r.command, "initialize") || !cmade)
      die("partial initialization refused");
    strcpy(r.tx,
           "0000000000000000000000000000000000000000000000000000000000000000");
    strcpy(r.basis, r.projected);
    strcpy(r.plan, "genesis");
  } else {
    char *cur = selector(meta);
    verify_gen(gs, cur, NULL);
    if (!strcmp(r.command, "inspect")) {
      printf("STATUS inspected\nGENERATION %s\n", cur);
      return 0;
    }
    if (strcmp(r.command, "apply"))
      die("already initialized");
    if (!hex64(r.tx))
      die("invalid transaction ID");
    int cg = odir(gs, cur);
    size_t mn;
    unsigned char *md = readfile(cg, "manifest.txt", 4u * 1024u * 1024u, &mn);
    char needle[256], plan_needle[256];
    snprintf(needle, sizeof needle, "\nPROJECTED %s\n", r.projected);
    snprintf(plan_needle, sizeof plan_needle, "\nPLAN %s\n", r.plan);
    if (strstr((char *)md, needle) && strstr((char *)md, plan_needle)) {
      verify_gen(gs, cur, &r);
      syncdir(meta);
      identity_path(root, r.run, rd, ri);
      identity_path(run, r.kase, cd, ci);
      identity_path(kase, ".f28-sync", meta_dev, meta_ino);
      identity_path(meta, "generations", generations_dev, generations_ino);
      if (fstatat(meta, "LOCK", &lp, AT_SYMLINK_NOFOLLOW) ||
          ls.st_ino != lp.st_ino || ls.st_dev != lp.st_dev)
        die("lock inode changed before retry acknowledgement");
      printf("STATUS already-applied\nGENERATION %s\n", cur);
      return 0;
    }
    snprintf(needle, sizeof needle, "\nPROJECTED %s\n", r.basis);
    if (!strstr((char *)md, needle))
      die("stale basis");
    free(md);
    close(cg);
    free(cur);
  }
  char stage[80];
  snprintf(stage, sizeof stage, "%s.staging", r.tx);
  if (present(gs, r.tx))
    verify_gen(gs, r.tx, &r);
  else if (present(gs, stage)) {
    verify_gen(gs, stage, &r);
    if (renameat(gs, stage, gs, r.tx))
      die("prepared recovery rename failed");
    syncdir(gs);
  } else {
    if (mkdirat(gs, stage, 0700))
      die("staging create failed");
    int g = odir(gs, stage);
    for (size_t i = 0; i < r.file_count; i++) {
      valid_path(r.files[i].path);
      for (size_t j = 0; j < i; j++)
        if (!strcmp(r.files[i].path, r.files[j].path))
          die("duplicate path");
      char *leaf;
      int p = file_parent(g, r.files[i].path, &leaf, 1);
      exclusive(p, leaf, r.files[i].data, r.files[i].len);
      syncdir(p);
      free(leaf);
      close(p);
      if (i == 0)
        inject(&r, "during-staging");
    }
    exclusive(g, "state.json", r.state, r.state_len);
    inject(&r, "before-prepared");
    char *m = manifest(&r);
    exclusive(g, "manifest.txt", m, strlen(m));
    free(m);
    syncdir(g);
    syncdir(gs);
    inject(&r, "after-prepared");
    close(g);
    if (renameat(gs, stage, gs, r.tx))
      die("generation rename failed");
    syncdir(gs);
    inject(&r, "after-generation-rename");
  }
  verify_gen(gs, r.tx, &r);
  pause_before_final_basis(&r);
  identity_path(root, r.run, rd, ri);
  identity_path(run, r.kase, cd, ci);
  identity_path(kase, ".f28-sync", meta_dev, meta_ino);
  identity_path(meta, "generations", generations_dev, generations_ino);
  if (fstatat(meta, "LOCK", &lp, AT_SYMLINK_NOFOLLOW) ||
      ls.st_ino != lp.st_ino || ls.st_dev != lp.st_dev)
    die("lock inode changed before publication");
  char *cur = present(meta, "CURRENT") ? selector(meta) : NULL;
  if (cur) {
    verify_gen(gs, cur, NULL);
    int cg = odir(gs, cur);
    size_t mn;
    unsigned char *md = readfile(cg, "manifest.txt", 4u * 1024u * 1024u, &mn);
    char needle[100];
    snprintf(needle, sizeof needle, "\nPROJECTED %s\n", r.basis);
    if (strcmp(cur, r.tx) && !strstr((char *)md, needle))
      die("basis changed before publication");
    free(md);
    close(cg);
    free(cur);
  }
  inject(&r, "before-current-rename");
  char pend[96];
  snprintf(pend, sizeof pend, "CURRENT.%s.pending", r.tx);
  if (!present(meta, pend)) {
    char sel[66];
    snprintf(sel, sizeof sel, "%s\n", r.tx);
    exclusive(meta, pend, sel, 65);
  } else
    validate_pending_selector(meta, pend, r.tx);
  inject(&r, "during-synchronization");
  syncdir(meta);
  if (renameat(meta, pend, meta, "CURRENT"))
    die("CURRENT publication failed");
  inject(&r, "after-current-rename");
  syncdir(meta);
  cur = selector(meta);
  if (strcmp(cur, r.tx))
    die("selector verification failed");
  free(cur);
  verify_gen(gs, r.tx, &r);
  inject(&r, "before-ack");
  printf("STATUS %s\nGENERATION %s\n",
         !strcmp(r.command, "initialize") ? "initialized" : "acknowledged",
         r.tx);
  return 0;
}
