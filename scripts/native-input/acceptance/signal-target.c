/* Real foreground process: report the inherited POSIX mask without changing it. */
#include <signal.h>
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc,char **argv){
    if(argc!=2&&argc!=3)return 2;
    if(argc==3){
        FILE *entries=fopen(argv[2],"ab");if(!entries)return 2;
        if(fputc('X',entries)==EOF){fclose(entries);return 2;}
        if(fclose(entries))return 2;
    }
    sigset_t mask;struct sigaction action;
    if(pthread_sigmask(SIG_SETMASK,NULL,&mask)||sigaction(SIGINT,NULL,&action))return 2;
    FILE *output=fopen(argv[1],"wx");if(!output)return 2;
    fprintf(output,"{\"pid\":%ld,\"group\":%ld,\"interruptBlocked\":%s,\"hangupBlocked\":%s,\"interruptIgnored\":%s}\n",(long)getpid(),(long)getpgrp(),
        sigismember(&mask,SIGINT)?"true":"false",sigismember(&mask,SIGHUP)?"true":"false",action.sa_handler==SIG_IGN?"true":"false");
    if(fclose(output))return 2;
    for(;;)pause();
}
