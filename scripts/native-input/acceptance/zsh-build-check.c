/* Fail closed if legacy configure probes failed instead of testing the host. */
#include "config.h"
#if defined(BROKEN_POSIX_SIGSUSPEND) || defined(BROKEN_KILL_ESRCH)
#error Unsupported or incorrectly detected Zsh host signal primitives
#endif
int main(void){return 0;}
