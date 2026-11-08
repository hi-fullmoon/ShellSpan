#ifndef SHELLSPAN_DARWIN_SETPGID_H
#define SHELLSPAN_DARWIN_SETPGID_H

#include <errno.h>
#include <sys/types.h>
#include <unistd.h>

/* Keep Darwin's real parent/child setpgid calls from overlapping. Only the
 * parent owns the write end after fork; EOF releases the child after the
 * parent's original assignment. Every original setpgid and error diagnostic
 * remains in jobs.c. No syscall failure is reclassified or suppressed.
 */
static pid_t
shellspan_darwin_fork (int synchronise, int descriptors[2])
{
  pid_t child;
  int saved_errno;
  ssize_t count;
  char byte;
  descriptors[0] = descriptors[1] = -1;
  if (synchronise && pipe (descriptors) < 0)
    return -1;
  child = fork ();
  if (child < 0)
    {
      saved_errno = errno;
      if (descriptors[0] >= 0) close (descriptors[0]);
      if (descriptors[1] >= 0) close (descriptors[1]);
      descriptors[0] = descriptors[1] = -1;
      errno = saved_errno;
      return -1;
    }
  if (child > 0)
    {
      if (descriptors[0] >= 0) close (descriptors[0]);
      descriptors[0] = -1;
      return child;
    }
  if (descriptors[1] >= 0) close (descriptors[1]);
  descriptors[1] = -1;
  if (descriptors[0] >= 0)
    {
      do count = read (descriptors[0], &byte, 1);
      while (count < 0 && errno == EINTR);
      close (descriptors[0]);
      descriptors[0] = -1;
      /* An unexpected read failure must never execute the job without the
       * synchronisation contract. The parent observes this real child exit. */
      if (count != 0) _exit (126);
    }
  return 0;
}

static void
shellspan_darwin_fork_parent_done (int descriptors[2])
{
  if (descriptors[1] >= 0) close (descriptors[1]);
  descriptors[1] = -1;
}

#endif
