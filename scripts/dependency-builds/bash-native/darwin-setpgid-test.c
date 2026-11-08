/* Real Darwin regression for the production fork synchronisation header.
 * No mocked syscall, synthetic error, ShellSpan App or user configuration.
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include "darwin-setpgid.h"

typedef struct { int rc, error; pid_t group, session; } Observation;
static void require(int valid, const char *operation) {
  if (!valid) { perror(operation); _exit(2); }
}
static void transfer(int fd, void *buffer, size_t bytes, int writing) {
  char *at = buffer;
  while (bytes) {
    ssize_t n = writing ? write(fd, at, bytes) : read(fd, at, bytes);
    if (n < 0 && errno == EINTR) continue;
    require(n > 0, "real pipe transfer");
    at += n; bytes -= (size_t)n;
  }
}
static void reap(pid_t pid) {
  int status; pid_t result;
  do { result = waitpid(pid, &status, 0); } while (result < 0 && errno == EINTR);
  require(result == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0, "owned child exit");
}
static void negative_cases(void) {
  int scenario;
  for (scenario = 0; scenario < 3; scenario++) {
    pid_t pid = fork(); require(pid >= 0, "negative fork");
    if (!pid) {
      pid_t own = getpid(), before = getpgrp(); int rc, error;
      if (scenario == 0) {
        errno = 0; require(getpgid(INT_MAX) == -1 && errno == ESRCH, "missing group precondition");
        rc = setpgid(own, INT_MAX); error = errno;
        require(rc == -1 && error == EPERM && getpgrp() == before, "real missing group remains EPERM");
        rc = setpgid(own, -1); error = errno;
        require(rc == -1 && error == EINVAL && getpgrp() == before, "real invalid group remains EINVAL");
      } else if (scenario == 1) {
        require(setsid() == own, "real session leader");
        rc = setpgid(own, own); error = errno;
        require(rc == -1 && error == EPERM && getpgrp() == own, "real session leader remains EPERM");
      } else {
        struct rlimit limit = {0, 0}; int descriptors[2];
        require(setrlimit(RLIMIT_NOFILE, &limit) == 0, "owned child descriptor limit");
        rc = (int)shellspan_darwin_fork(1, descriptors); error = errno;
        require(rc == -1 && error == EMFILE && descriptors[0] == -1 && descriptors[1] == -1, "real pipe exhaustion propagates");
      }
      _exit(0);
    }
    reap(pid);
  }
}
int main(int argc, char **argv) {
  if (argc != 3 && argc != 4) return 2;
  int verbose = argc == 4;
  if (verbose && strcmp(argv[3], "--verbose")) return 2;
  int synchronise;
  if (!strcmp(argv[1], "serialised")) synchronise = 1;
  else if (!strcmp(argv[1], "no-job-control")) synchronise = 0;
  else return 2;
  char *end; long iterations = strtol(argv[2], &end, 10);
  if (*end || iterations < 1 || iterations > 2000) return 2;
  alarm(30); negative_cases();
  pid_t session = getsid(0), inherited_group = getpgrp();
  long parent_errors = 0, child_errors = 0, wrong_groups = 0, changed_sessions = 0;
  for (long index = 0; index < iterations; index++) {
    int channel[2], descriptors[2];
    require(socketpair(AF_UNIX, SOCK_STREAM, 0, channel) == 0, "observation socket");
    pid_t pid = shellspan_darwin_fork(synchronise, descriptors);
    require(pid >= 0, "real synchronised fork");
    char release = 'x';
    if (!pid) {
      close(channel[0]); Observation child = {0};
      require(descriptors[0] == -1 && descriptors[1] == -1, "child sync descriptors closed");
      child.rc = synchronise ? setpgid(getpid(), getpid()) : 0;
      child.error = child.rc < 0 ? errno : 0;
      child.group = getpgrp(); child.session = getsid(0);
      transfer(channel[1], &child, sizeof child, 1);
      transfer(channel[1], &release, 1, 0);
      close(channel[1]); _exit(0);
    }
    close(channel[1]); int sync_fd = descriptors[1];
    int parent_rc = synchronise ? setpgid(pid, pid) : 0;
    int parent_errno = parent_rc < 0 ? errno : 0;
    shellspan_darwin_fork_parent_done(descriptors);
    require(descriptors[0] == -1 && descriptors[1] == -1, "parent sync descriptors reset");
    if (synchronise) {
      errno = 0; require(fcntl(sync_fd, F_GETFD) == -1 && errno == EBADF, "parent sync descriptor actually closed");
    }
    Observation child;
    transfer(channel[0], &child, sizeof child, 0);
    pid_t actual_group = getpgid(pid), actual_session = getsid(pid);
    pid_t wanted_group = synchronise ? pid : inherited_group;
    parent_errors += parent_rc < 0; child_errors += child.rc < 0;
    wrong_groups += actual_group != wanted_group || child.group != wanted_group;
    changed_sessions += actual_session != session || child.session != session;
    if (verbose) printf("{\"index\":%ld,\"pid\":%d,\"parentRc\":%d,\"parentErrno\":%d,"
           "\"childRc\":%d,\"childErrno\":%d,\"group\":%d,\"childGroup\":%d,"
           "\"session\":%d,\"childSession\":%d,\"expectedSession\":%d}\n",
           index, pid, parent_rc, parent_errno, child.rc, child.error,
           actual_group, child.group, actual_session, child.session, session);
    transfer(channel[0], &release, 1, 1); close(channel[0]); reap(pid);
  }
  printf("{\"event\":\"summary\",\"mode\":\"%s\",\"iterations\":%ld,"
         "\"parentErrors\":%ld,\"childErrors\":%ld,\"wrongGroup\":%ld,"
         "\"changedSession\":%ld,\"negativeScenarios\":4,\"nativeExecutionCredit\":0}\n",
         argv[1], iterations, parent_errors, child_errors, wrong_groups, changed_sessions);
  return parent_errors || child_errors || wrong_groups || changed_sessions ? 1 : 0;
}
