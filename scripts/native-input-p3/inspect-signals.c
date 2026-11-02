/* Read-only macOS signal diagnosis through the SDK's native process struct. */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
int main(int argc,char **argv){
    if(argc!=2)return 2;
    char *end;errno=0;long value=strtol(argv[1],&end,10);
    if(errno||*end||value<=1||value>INT_MAX)return 2;
    int mib[]={CTL_KERN,KERN_PROC,KERN_PROC_PID,(int)value};
    struct kinfo_proc process;size_t size=sizeof(process);
    if(sysctl(mib,4,&process,&size,NULL,0)||size!=sizeof(process))return 1;
    printf("{\"pid\":%ld,\"interruptIgnored\":%s,\"interruptCaught\":%s,\"ignored\":%u,\"caught\":%u}\n",value,
        sigismember(&process.kp_proc.p_sigignore,SIGINT)?"true":"false",
        sigismember(&process.kp_proc.p_sigcatch,SIGINT)?"true":"false",
        process.kp_proc.p_sigignore,process.kp_proc.p_sigcatch);
    return 0;
}
