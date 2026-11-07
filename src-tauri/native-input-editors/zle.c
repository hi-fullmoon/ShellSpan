/* Only Zsh's documented module/builtin API and ZLE special parameters are used.
 * The editor remains single-threaded, including its public zselect waits. */
#define IMPORTING_MODULE_zshQsmain 1
#include "zsh.mdh"
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <pthread.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <langinfo.h>
#include <strings.h>
#include <dlfcn.h>
#include <sys/ioctl.h>
#include <limits.h>

extern void *ss_editor_new(const char *, int);
extern int ss_editor_receive(void *, const unsigned char *, size_t);
extern int ss_editor_observe_chars(void *, const char *, size_t);
extern int ss_editor_eof_owned_chars(void *, const char *, size_t);
extern int ss_editor_eof_cleared(void *, const char *, size_t);
extern size_t ss_editor_owned_source_size(void *);
extern int ss_editor_complete_source(void *, const char *);
extern int ss_editor_action(void *);
extern const char *ss_editor_text(void *);
extern int ss_editor_event(void *, int, int, const char *);
extern const unsigned char *ss_editor_output(void *, size_t *);
extern const char *ss_editor_marker(void *, int);
extern const char *ss_editor_plan(void *, const char *);
extern const char *ss_editor_validation_plan(void *);
extern const char *ss_editor_job(void *, int);
extern int ss_editor_job_observation(void *, const char *, const char *, int, int);
extern void ss_editor_drop(void *);
static void *editor;
static int endpoint = -1;
static int fork_registered;
static sigset_t handoff_mask;
static int handoff_masked;
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
typedef int (*NativeHistoryBind)(const char *, const char *);
typedef void (*NativeHistoryChild)(pid_t);
static NativeHistoryBind history_bind;
static NativeHistoryChild history_child;
static pid_t history_parent;
static int history_job;
#endif
static void restore_handoff(void) {
    if(handoff_masked) {
        handoff_masked=0;
        if(!sigismember(&handoff_mask,SIGWINCH)) {sigset_t resize;sigemptyset(&resize);sigaddset(&resize,SIGWINCH);sigprocmask(SIG_UNBLOCK,&resize,NULL);}
    }
}
static void child_closed(void) {
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
    /* Parent-owned native history must not be flushed by the asynchronous
     * child's normal/TERM exit. The validated callback only sets a main flag;
     * no allocation, lookup, shell callback or Rust state is used after fork. */
    if(history_job&&history_child) history_child(history_parent);
    history_job=0;
    history_child=NULL;
#endif
    restore_handoff();
    if (endpoint >= 0) close(endpoint);
    endpoint = -1;
    editor = NULL;
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
    history_bind = NULL;
#endif
}
static int flush_output(void) {
    size_t size;
    const unsigned char *bytes;
    while ((bytes = ss_editor_output(editor,&size)) && size) {
        size_t offset = 0;
        while (offset < size) {
            ssize_t n = send(endpoint,bytes+offset,size-offset,
#ifdef MSG_NOSIGNAL
                MSG_NOSIGNAL
#else
                0
#endif
            );
            if (n > 0) offset += (size_t)n;
            else if (n < 0 && errno == EINTR) continue;
            else return 1;
        }
    }
    return 0;
}
static char *plain(char *value) {
    char *copy = ztrdup(value); int len;
    unmetafy(copy,&len);
    if((size_t)len!=strlen(copy)) {zsfree(copy);return NULL;}
    return copy;
}
static int observe(char **args) {
    char *buffer = plain(args[0]);
    if(!buffer) return 1;
    char *end; unsigned long long cursor = strtoull(args[1],&end,10);
    int valid = *args[1] && !*end && ss_editor_observe_chars(editor,buffer,(size_t)cursor);
    zsfree(buffer); return !valid;
}
static void stream_marker(int end) {
    const char *marker = ss_editor_marker(editor,end);
    if (marker) (void)write(STDOUT_FILENO,marker,strlen(marker));
}
static int bin_ssnip(char *name, char **args, Options opts, int func) {
    (void)name; (void)opts; (void)func;
    int count=0; while (args[count]) count++;
    if (count == 4 && !strcmp(args[0],"open")) {
        if (editor) return 1;
        /* The native profile is bound to this exact public Core API
         * and to the private file copied and hashed by the loader. No private
         * ZLE structure or exported implementation routine is inspected. */
        char expected[PATH_MAX],actual[PATH_MAX];Dl_info information;
        void *symbol=dlsym(RTLD_DEFAULT,"zle_native_append_mode");
        char *module_path=plain(args[1]);if(!module_path)return 1;
        char *last=strrchr(module_path,'/');if(!last){zsfree(module_path);return 1;}*last=0;
        char core_path[PATH_MAX];int length=snprintf(core_path,sizeof(core_path),"%s/scoped/zsh/zle.so",module_path);zsfree(module_path);
        if(length<0||(size_t)length>=sizeof(core_path)||!symbol||!dladdr(symbol,&information)||!information.dli_fname||
            !realpath(core_path,expected)||!realpath(information.dli_fname,actual)||strcmp(expected,actual)){
            zwarnnam(name,"TERMINAL_NATIVE_SCOPED_CORE_MISMATCH");return 1;
        }
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
        int (*history_api)(void)=(int (*)(void))dlsym(RTLD_DEFAULT,"zle_native_history_api");
        history_bind=(NativeHistoryBind)dlsym(RTLD_DEFAULT,"zle_native_bind_handoff");
        history_child=(NativeHistoryChild)dlsym(RTLD_DEFAULT,"zle_native_history_child");
        Dl_info history_info;
        if(!history_api||!history_bind||!history_child||history_api()!=1||
            !dladdr((void *)history_api,&history_info)||!history_info.dli_fname||
            !realpath(history_info.dli_fname,actual)||strcmp(expected,actual)||
            !dladdr((void *)history_bind,&history_info)||!history_info.dli_fname||
            !realpath(history_info.dli_fname,actual)||strcmp(expected,actual)||
            !dladdr((void *)history_child,&history_info)||!history_info.dli_fname||
            !realpath(history_info.dli_fname,actual)||strcmp(expected,actual)) {
            history_bind=NULL;history_child=NULL;zwarnnam(name,"TERMINAL_NATIVE_HISTORY_API_UNAVAILABLE");return 1;
        }
        history_parent=getpid();history_job=0;
#endif
        const char *codeset=nl_langinfo(CODESET);
        if(!codeset || (strcasecmp(codeset,"UTF-8") && strcasecmp(codeset,"UTF8"))) {zwarnnam(name,"TERMINAL_NATIVE_UTF8_LOCALE_REQUIRED");return 1;}
        if(!fork_registered) { if(pthread_atfork(NULL,NULL,child_closed)) return 1; fork_registered=1; }
        char *path=plain(args[1]), *profile=plain(args[2]);
        if(!path || !profile) {if(path)zsfree(path);if(profile)zsfree(profile);return 1;}
        struct sockaddr_un address; memset(&address,0,sizeof(address));
        address.sun_family=AF_UNIX;
        if (strlen(path)>=sizeof(address.sun_path)) { zsfree(path); zsfree(profile); return 1; }
        strcpy(address.sun_path,path); zsfree(path);
        endpoint=socket(AF_UNIX,SOCK_STREAM,0);
        if(endpoint<0) { zsfree(profile); return 1; }
        fcntl(endpoint,F_SETFD,FD_CLOEXEC);
#ifdef SO_NOSIGPIPE
        int yes=1; setsockopt(endpoint,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes));
#endif
        struct timeval timeout={1,0}; setsockopt(endpoint,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
        if(connect(endpoint,(struct sockaddr *)&address,sizeof(address))) { close(endpoint); endpoint=-1; zsfree(profile); return 1; }
        editor=ss_editor_new(profile,!strcmp(args[3],"1")); zsfree(profile);
        if(!editor) {close(endpoint);endpoint=-1;return 1;}
        setiparam("SS_NIP_FD",endpoint);
        return 0;
    }
    if(!editor) return 1;
    if(count==2&&!strcmp(args[0],"complete-source")){
        char *actual=plain(args[1]);if(!actual)return 1;
        int complete=ss_editor_complete_source(editor,actual);zsfree(actual);return !complete;
    }
    if(count==1&&!strcmp(args[0],"display-budget")){
        size_t source=ss_editor_owned_source_size(editor);struct winsize geometry;
        int terminal=open("/dev/tty",O_RDONLY|O_CLOEXEC);
        if(terminal<0)return 1;
        int measured=ioctl(terminal,TIOCGWINSZ,&geometry);close(terminal);
        if(measured||!source||source>8192||!geometry.ws_row||geometry.ws_col<8)return 1;
        /* One input byte per visual row is a conservative native bound, plus
         * the actual viewport and 34 prompt/status rows. Bound total cache
         * cells as well; neither COLUMNS nor LINES is changed. */
        size_t rows=source+(size_t)geometry.ws_row+34;
        if(rows>16384||rows*(size_t)geometry.ws_col>2097152)return 1;
        setiparam("SS_NIP_DISPLAY_LINES",(zlong)rows);
        setiparam("SS_NIP_KERNEL_ROWS",geometry.ws_row);setiparam("SS_NIP_KERNEL_COLS",geometry.ws_col);
        return 0;
    }
    if(count == 1 && !strcmp(args[0],"pending-handoff")) return ss_editor_event(editor,15,0,NULL) != 1;
    if(count == 3 && (!strcmp(args[0],"eof-owned") || !strcmp(args[0],"eof-cleared"))) {
        char *buffer=plain(args[1]);if(!buffer)return 1;
        char *end;unsigned long long cursor=strtoull(args[2],&end,10);
        int owned=*args[2]&&!*end&&(!strcmp(args[0],"eof-owned")?
            ss_editor_eof_owned_chars(editor,buffer,(size_t)cursor):ss_editor_eof_cleared(editor,buffer,(size_t)cursor));
        zsfree(buffer);return !owned;
    }
    if(count == 1 && !strcmp(args[0],"idle")) return ss_editor_event(editor,9,0,NULL) != 0;
    if(count == 1 && !strcmp(args[0],"typing")) return !ss_editor_event(editor,7,0,NULL);
    if(count == 1 && !strcmp(args[0],"close")) {
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
        history_job=0;
#endif
        restore_handoff();
        ss_editor_event(editor,6,0,NULL);
        if(endpoint>=0) {shutdown(endpoint,SHUT_RDWR);close(endpoint);endpoint=-1;}
        return 0;
    }
    if(count == 3 && !strcmp(args[0],"tick")) {
        if(observe(args+1)) return 1;
        unsigned char bytes[8192]; ssize_t n;
        while((n=recv(endpoint,bytes,sizeof(bytes),MSG_DONTWAIT))>0) {
            if(!ss_editor_receive(editor,bytes,(size_t)n)) return 1;
        }
        if(n==0 || (n<0 && errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR)) {
            ss_editor_event(editor,6,0,NULL); return 1;
        }
        int action=ss_editor_action(editor);
        if(action<0) return 1;
        setsparam("SS_NIP_TEXT",metafy((char *)ss_editor_text(editor),-1,META_DUP));
        setiparam("SS_NIP_ACTION",action);
        return flush_output();
    }
    if(count == 3 && (!strcmp(args[0],"ack") || !strcmp(args[0],"accept"))) {
        if(observe(args+1)) return 1;
        int result=ss_editor_event(editor,!strcmp(args[0],"ack")?1:2,0,NULL);
        if(flush_output()) return 1;
        return !result;
    }
    if(count == 1 && !strcmp(args[0],"begin")) {
        restore_handoff();
        stream_marker(0);
        if(!ss_editor_event(editor,3,0,NULL)) return 1;
        return flush_output();
    }
    if(count == 2 && !strcmp(args[0],"validate")) {
        int result=ss_editor_event(editor,10,!strcmp(args[1],"1"),NULL);
        return flush_output() || !result;
    }
    if(count==1 && !strcmp(args[0],"validation-plan")) {
        const char *plan=ss_editor_validation_plan(editor);if(!plan)return 1;
        setsparam("SS_NIP_VALIDATION_PLAN",metafy((char *)plan,-1,META_DUP));return 0;
    }
    if(count == 3 && !strcmp(args[0],"options")) {
        ss_editor_event(editor,11,(!strcmp(args[1],"on")?1:0)|(!strcmp(args[2],"on")?2:0),NULL);
        return flush_output();
    }
    if(count == 1 && !strcmp(args[0],"job")) {
        setsparam("SS_NIP_JOB_KIND",metafy((char *)ss_editor_job(editor,0),-1,META_DUP));
        setsparam("SS_NIP_JOB_HANDLE",metafy((char *)ss_editor_job(editor,1),-1,META_DUP));
        setsparam("SS_NIP_JOB_ACTION",metafy((char *)ss_editor_job(editor,2),-1,META_DUP));
        return 0;
    }
    if(count == 2 && !strcmp(args[0],"plan")) {
        if(!ss_editor_event(editor,15,0,NULL)) return 2;
        char *source=plain(args[1]);
        if(!source) return 1;
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
        /* Rust string exports share one borrowed CString slot. Read job kind
         * before obtaining the plan; no later export may invalidate plan. */
        const char *history_kind=ss_editor_job(editor,0);
        int history_launch=history_kind&&!strcmp(history_kind,"launch");
#endif
        const char *plan=ss_editor_plan(editor,source);
        if(!plan) {zsfree(source);return 1;}
        if(strcmp(plan,source) && !handoff_masked) {
            sigset_t resize;sigemptyset(&resize);sigaddset(&resize,SIGWINCH);
            if(sigprocmask(SIG_BLOCK,&resize,&handoff_mask)) {zsfree(source);return 1;}
            handoff_masked=1;
        }
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
        if(!history_bind) {zsfree(source);return 1;}
        char *history_source=metafy(source,-1,META_DUP),*history_plan=metafy((char *)plan,-1,META_DUP);
        int history_result=history_bind(history_source,history_plan);
        zsfree(history_source);zsfree(history_plan);
        if(history_result) {zsfree(source);return 1;}
        history_job=history_launch;
#endif
        zsfree(source);
        setsparam("SS_NIP_PLAN",metafy((char *)plan,-1,META_DUP));return 0;
    }
    if(count == 4 && !strcmp(args[0],"job-observation")) {
        int result=ss_editor_job_observation(editor,args[1],args[2],atoi(args[3]),strcmp(args[3],"-")!=0);
        return flush_output() || !result;
    }
    if(count == 2 && !strcmp(args[0],"settle")) {
#ifdef SHELLSPAN_ZLE_BOUND_HISTORY
        history_job=0;
#endif
        restore_handoff();
        stream_marker(1); ss_editor_event(editor,4,atoi(args[1]),NULL);
        return flush_output();
    }
    if(count == 4 && !strcmp(args[0],"ready")) {
        if(observe(args+1)) return 1;
        char *cwd=plain(args[3]);if(!cwd)return 1; ss_editor_event(editor,5,0,cwd); zsfree(cwd);
        return flush_output();
    }
    return 1;
}
static struct builtin bintab[] = { BUILTIN("ss_nip",0,bin_ssnip,1,4,0,NULL,NULL) };
static struct features module_features = { bintab,1,NULL,0,NULL,0,NULL,0,0 };
int setup_(Module m) { (void)m; return 0; }
int features_(Module m,char ***features) { *features=featuresarray(m,&module_features); return 0; }
int enables_(Module m,int **enables) { return handlefeatures(m,&module_features,enables); }
int boot_(Module m) { (void)m; return 0; }
int cleanup_(Module m) {
    /* pthread_atfork has no unregister API. Keep its code mapped for the
     * lifetime of this shell, including after the private channel closes. */
    if(fork_registered) return 1;
    if(editor) ss_editor_drop(editor); editor=NULL;
    child_closed();
    return setfeatureenables(m,&module_features,NULL);
}
int finish_(Module m) { (void)m; return 0; }
