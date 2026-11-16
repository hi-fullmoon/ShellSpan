/* ShellSpan NIP loadable builtin; compile against the verified target headers.
 * The target Bash parser is used only in a bounded parse-only fork. No user
 * source is evaluated there, and no private Readline symbols are used. */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#include <config.h>
#include <sys/types.h>
#include "shell.h"
#include "builtins.h"
#include "builtins/common.h"
#include "bashjmp.h"
#include "trap.h"
#include "flags.h"
#include <stdlib.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <readline/readline.h>
#include <dlfcn.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <langinfo.h>
#include <signal.h>
#include <stdint.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <time.h>
#ifdef __GLIBC__
#include <gnu/libc-version.h>
#endif
extern int p0_start(const char *path, const char *shell_version);
extern int p0_status(int status, const char *cwd);
extern void p0_stop(void);
extern int p0_begin(int status);
extern int p0_control_closed(void);
extern int ss_native_job(const char *handle, const char *state, const char *status);
extern int ss_native_control_access(void);
extern int ss_native_control_begin(const char *handle, const char *action, const char *nonce);
extern int ss_native_control_end(int status, const char *cwd);
extern void ss_native_control_returned(void);
extern int p0_tick(void);
extern int p0_pending_validation(uint64_t *, char **, char **, uint64_t *);
extern void p0_validation_text_free(char *);
extern int p0_validation_complete(uint64_t, int);
extern int p0_needs_tick(void);
extern void p0_editor_ready(int bindings_valid);
extern int p0_commit_key(int count, int key);
extern void p0_service(void);
static int (*native_prompt_columns)(void);
static int native_display_abi_available(void) {
  if (!native_prompt_columns)
    native_prompt_columns=(int (*)(void))dlsym(RTLD_DEFAULT,"rl_native_prompt_columns");
  return native_prompt_columns != NULL;
}
int p0_builtin_load(char *name) {
  static void *image_pin;
  Dl_info information;
  (void)name;
  if (image_pin) return 1;
  /* This explicit native ABI is part of the verified target build. Never
   * substitute another Shell or fall back to guessing prompt columns. */
  if (!native_display_abi_available()) return 0;
#ifdef RTLD_NODELETE
  /* pthread_atfork has no portable unregister API. Keep its code mapped for
   * this shell's lifetime even after enable -d removes the entry points. */
  if (dladdr((void *)p0_builtin_load, &information) == 0) return 0;
  image_pin = dlopen(information.dli_fname, RTLD_NOW | RTLD_NODELETE);
  return image_pin != NULL;
#else
  return 0;
#endif
}
static rl_hook_func_t *saved_hook;
static rl_hook_func_t *saved_pre_input;
static Keymap owned_map;
static rl_voidfunc_t *saved_redisplay;
static struct winsize display_geometry;
static int geometry_display_active, display_rebases;
static int viewport_protected;
static int append_display_active;
static size_t displayed_bytes;
static size_t append_prompt_columns;
static int handoff_display_active;
static rl_voidfunc_t *handoff_saved_redisplay;
static rl_command_func_t *control_bash_function;
static FILE *control_sink, *control_real_outstream;
static volatile sig_atomic_t control_redraw_active;
static volatile sig_atomic_t control_int_guard;
static struct sigaction control_saved_int;
static struct sigaction control_shell_int;
static sigset_t control_entry_mask;
static volatile sig_atomic_t control_mask_owned;
static int control_dispatch_key(int count, int key);
static void control_interrupted(int signal_number, siginfo_t *info, void *context);
static void restore_control_int(void) {
  struct sigaction current;
  if (control_int_guard && sigaction(SIGINT,NULL,&current)==0
      && (current.sa_flags & SA_SIGINFO) && current.sa_sigaction==control_interrupted)
    sigaction(SIGINT,&control_saved_int,NULL);
  control_int_guard=0;
}
static void finish_control_redraw(void) {
  if (control_redraw_active && rl_outstream == control_sink)
    rl_outstream = control_real_outstream;
  control_redraw_active = 0;
  control_real_outstream = NULL;
  restore_control_int();
  if (control_mask_owned) {control_mask_owned=0;sigprocmask(SIG_SETMASK,&control_entry_mask,NULL);}
}
static void control_interrupted(int signal_number, siginfo_t *info, void *context) {
  int saved_errno=errno;
  /* Bash may longjmp over the bind-x C callback. Restore the public stream
   * before invoking its original signal disposition, using only signal-safe
   * pointer stores and sigaction. Never invoke Rust or stdio from this hook. */
  finish_control_redraw();
  errno=saved_errno;
  if (control_shell_int.sa_flags & SA_SIGINFO)
    control_shell_int.sa_sigaction(signal_number,info,context);
  else
    control_shell_int.sa_handler(signal_number);
}
static int protect_control_int(void) {
  struct sigaction guarded;
  if (sigaction(SIGINT,NULL,&control_saved_int)!=0) return 1;
  if (control_saved_int.sa_handler==SIG_DFL || control_saved_int.sa_handler==SIG_IGN) return 1;
  guarded=control_saved_int;
  guarded.sa_sigaction=control_interrupted;
  guarded.sa_flags|=SA_SIGINFO;
  control_int_guard=1;
  if (sigaction(SIGINT,&guarded,NULL)!=0) {control_int_guard=0;return 1;}
  if (sigprocmask(SIG_BLOCK,NULL,&control_entry_mask)!=0) {restore_control_int();return 1;}
  control_mask_owned=1;
  return 0;
}
static void control_enable_interrupt(void) {
  sigset_t mask;
  if (control_redraw_active && control_int_guard && sigprocmask(SIG_BLOCK,NULL,&mask)==0) {
    sigdelset(&mask,SIGINT);
    sigprocmask(SIG_SETMASK,&mask,NULL);
  }
}
#ifdef __APPLE__
static int discard_readline(void *cookie, const char *bytes, int size) {
  (void)cookie; (void)bytes; return size;
}
#else
static ssize_t discard_readline(void *cookie, const char *bytes, size_t size) {
  (void)cookie; (void)bytes; return (ssize_t)size;
}
#endif
static FILE *open_readline_sink(void) {
#ifdef __APPLE__
  return funopen(NULL, NULL, discard_readline, NULL, NULL);
#else
  cookie_io_functions_t functions = { .read = NULL, .write = discard_readline, .seek = NULL, .close = NULL };
  return fopencookie(NULL, "w", functions);
#endif
}
void ss_native_control_after_fork(void) {
  /* No OS descriptor belongs to the libc cookie sink. Never leave a native
   * child using the parent's transient Readline output stream. */
  finish_control_redraw();
}
static void handoff_display(void) {}
static void finish_handoff_display(void) {
  if (handoff_display_active && rl_redisplay_function == handoff_display)
    rl_redisplay_function = handoff_saved_redisplay;
  handoff_display_active = 0;
}
static int exit_registered;
static pid_t display_owner;
static void finish_display(void);
static void display_mode(int enabled) {
  FILE *stream = rl_outstream ? rl_outstream : stdout;
  fputs(enabled ? "\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\007"
                : "\033]1337;SetUserVar=ShellSpanNativeInput=MA==\007", stream);
  fflush(stream);
}
void ss_native_capture_fence(const char *value) {
  FILE *stream = control_redraw_active ? control_real_outstream : (rl_outstream ? rl_outstream : stdout);
  fputs(value, stream);
  fflush(stream);
}
static void display_at_exit(void) {
  if (getpid() == display_owner && append_display_active) finish_display();
}
static unsigned append_tab_spaces(const char *text, size_t end) {
  size_t column=append_prompt_columns, offset=0;
  mbstate_t state;
  memset(&state,0,sizeof(state));
  while (offset<end) {
    size_t count=1;
    unsigned char character=(unsigned char)text[offset];
    if (character=='\n') column=0;
    else if (character=='\r') column+=2;
    else if (character=='\t') column+=8-column%8;
    else {
      wchar_t wc;
      int width=1;
      count=mbrtowc(&wc,text+offset,end-offset,&state);
      if (count==(size_t)-1 || count==(size_t)-2 || !count) {
        memset(&state,0,sizeof(state));
        count=1;
      } else {
        width=wcwidth(wc);
        if (width<0) width=2;
      }
      column+=(size_t)width;
    }
    offset+=count;
  }
  return (unsigned)(8-column%8);
}
static void append_display(void) {
  size_t length = strlen(rl_line_buffer);
  if (rl_point != rl_end) return; /* The owner detects foreign editor changes. */
  if (length == 0 && displayed_bytes != 0) {
    rl_crlf();
    rl_on_new_line();
    displayed_bytes = 0;
    return;
  }
  if (length < displayed_bytes) return;
  /* A Readline redisplay provider for the owned, immutable growing draft.
   * The actual editor buffer is the only text source. Readline supplies its
   * native prompt columns; libc measures the actual prefix for a Tab stop.
   * The terminal owns wrapping and cursor placement. No screen replay or
   * full-draft restore occurs; CR retains its native visible representation. */
  for (size_t index=displayed_bytes;index<length;index++) {
    unsigned char character=(unsigned char)rl_line_buffer[index];
    if (character=='\r') fputs("^M",rl_outstream);
    else if (character=='\t') {
      unsigned spaces=append_tab_spaces(rl_line_buffer,index);
      while (spaces--) fputc(' ',rl_outstream);
    }
    else fputc(character,rl_outstream);
  }
  fflush(rl_outstream);
  displayed_bytes = length;
}
int p0_begin_append_display(void) {
  int columns;
  if (rl_redisplay_function != rl_redisplay) return 1;
  if (!native_prompt_columns) return 1;
  columns=native_prompt_columns();
  if (columns<0) return 1;
  append_prompt_columns=(size_t)columns;
  if (!exit_registered) {
    if (atexit(display_at_exit) != 0) return 1;
    exit_registered = 1;
  }
  saved_redisplay=rl_redisplay_function;
  displayed_bytes=0;
  append_display_active=1;
  display_owner=getpid();
  display_mode(1);
  rl_redisplay_function=append_display;
  return 0;
}
void p0_paint_line(void) { (*rl_redisplay_function)(); }
void p0_native_history(const char *wrapper, const char *source) {
  typedef void (*history_handoff)(const char *, const char *);
  history_handoff save = (history_handoff)dlsym(RTLD_DEFAULT, "bash_shellspan_native_history");
  if (save) save(wrapper, source);
}
void p0_accept_line(void) {
  if (append_display_active) {
    /* rl_done is the documented accept/return API. The default final redisplay
     * cannot be used because this provider intentionally keeps no physical
     * cursor cache in Readline; the real terminal owns wrapping and reflow. */
    rl_crlf();
    rl_done=1;
    rl_on_new_line();
  } else rl_newline(1,13);
  /* rl_done does not prevent the dispatcher from processing pending WINCH.
   * Protect only the already-accepted hidden return line until Readline has
   * actually returned to Bash. No source replay or cursor calculation occurs. */
  handoff_saved_redisplay =
    (append_display_active || geometry_display_active) ? saved_redisplay : rl_redisplay_function;
  handoff_display_active = 1;
  rl_redisplay_function = handoff_display;
}
int ss_native_queue_control(void) {
  return rl_stuff_char(0x18) && rl_stuff_char(0x1f) ? 0 : 1;
}
static void native_new_line(int preserve_viewport) {
  struct winsize current;
  rl_crlf();
  if (preserve_viewport && ioctl(fileno(rl_instream), TIOCGWINSZ, &current) == 0) {
    /* Move real existing rows into scrollback before Readline's own large
     * buffer clear. No screen data or command text is copied or replayed. */
    for (unsigned row=0;row<current.ws_row;row++) rl_crlf();
  }
  rl_on_new_line();
  display_rebases++;
}
static void geometry_display(void) {
  struct winsize current;
  if (ioctl(fileno(rl_instream), TIOCGWINSZ, &current) == 0 &&
      (current.ws_col != display_geometry.ws_col || current.ws_row != display_geometry.ws_row)) {
    /* One native rebase per actual geometry change, never per typing frame.
     * No existing output or screen contents are read, copied or replayed. */
    native_new_line(1);
    display_geometry = current;
  }
  saved_redisplay();
}
int p0_finish_preview(void) {
  viewport_protected=1;
  native_new_line(1);
  return 0;
}
int p0_preview_bytes(void) {
  struct winsize current;
  if (ioctl(fileno(rl_instream), TIOCGWINSZ, &current) != 0) return 0;
  /* Conservative bytes/row resource bound, not a cell/cursor calculation:
   * even LF consumes at most one row per byte in the frozen one-line prompt
   * profile. Whole graphemes are still selected by unicode-segmentation. */
  return current.ws_row>3?current.ws_row-3:0;
}
int p0_begin_display(int geometry) {
  display_rebases = 0;
  if (geometry) {
    if (rl_redisplay_function != rl_redisplay ||
        ioctl(fileno(rl_instream), TIOCGWINSZ, &display_geometry) != 0) return 1;
    saved_redisplay = rl_redisplay_function;
    geometry_display_active = 1;
    rl_redisplay_function = geometry_display;
  }
  rl_crlf();
  rl_on_new_line();
  display_rebases++;
  return 0;
}
int p0_display_rebases(void) { return display_rebases; }
static void finish_display(void) {
  if (append_display_active) display_mode(0);
  if (handoff_display_active) {
    geometry_display_active = viewport_protected = append_display_active = 0;
    return;
  }
  if (geometry_display_active && rl_redisplay_function == geometry_display)
    rl_redisplay_function = saved_redisplay;
  if (append_display_active && rl_redisplay_function == append_display)
    rl_redisplay_function = saved_redisplay;
  geometry_display_active = 0;
  viewport_protected = 0;
  append_display_active = 0;
}
void p0_release_owned_display(void) {
  /* Clear acknowledgement must release our renderer before a new prepare or
   * user edit can arrive. Leave event-hook teardown to its safe service key. */
  finish_display();
}
static int installed_input, in_service_key, service_queued;
static int service_key(int count, int key);
static int finish_key(int count, int key);
int p0_bindings_valid(void) {
  int kind;
  return rl_function_of_keyseq("\x18\x1e", rl_get_keymap(), &kind) == service_key
      && rl_function_of_keyseq("\030b", rl_get_keymap(), &kind) == finish_key
      && rl_function_of_keyseq("\030a", rl_get_keymap(), &kind) == p0_commit_key
      && rl_function_of_keyseq("\x18\x1f", rl_get_keymap(), &kind) == control_dispatch_key;
}
static int control_dispatch_key(int count, int key) {
  int result;
  if (ss_native_control_access() != 0 || !control_bash_function) {
    ss_native_control_returned();
    return 0;
  }
  /* The documented bind-x callback executes only our fixed typed control
   * function with SEVAL_NOHIST. No line is accepted, so even a full HISTSIZE
   * cannot evict a user entry. User source never takes this path.
   * Suppress only Readline's empty widget clear/redraw through its public
   * output stream; Bash/program stdout and stderr remain the real PTY. */
  if (protect_control_int()!=0) {ss_native_control_returned();return 1;}
  control_real_outstream=rl_outstream;
  control_redraw_active=1;
  rl_outstream=control_sink;
  result=control_bash_function(count,key);
  finish_control_redraw();
  ss_native_control_returned();
  return result;
}
static int editor_ready(void) {
  /* A fresh native input line is also a safe fallback restoration boundary. */
  finish_handoff_display();
  finish_control_redraw();
  if (saved_pre_input) saved_pre_input();
  /* Bash may finish initializing Readline after rc loading. Only reattach a
   * genuinely empty private binding; a configured user binding wins. */
  int kind;
  if (!rl_function_of_keyseq("\x18\x1e", rl_get_keymap(), &kind))
    rl_bind_keyseq("\x18\x1e", service_key);
  if (!rl_function_of_keyseq("\030a", rl_get_keymap(), &kind))
    rl_bind_keyseq("\030a", p0_commit_key);
  if (!rl_function_of_keyseq("\030b", rl_get_keymap(), &kind))
    rl_bind_keyseq("\030b", finish_key);
  p0_editor_ready(p0_bindings_valid());
  return 0;
}
static uint64_t validation_clock_ms(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) return 0;
  return (uint64_t)time.tv_sec * 1000 + (uint64_t)time.tv_nsec / 1000000;
}
static int parse_only_child(const char *source, const char *plan) {
  const int flags = SEVAL_NOHIST | SEVAL_RESETLINE | SEVAL_PARSEONLY;
  char *source_copy, *plan_copy;
  int sink = open("/dev/null", O_RDWR);
  if (sink < 0 || dup2(sink, STDIN_FILENO) < 0 ||
      dup2(sink, STDOUT_FILENO) < 0 || dup2(sink, STDERR_FILENO) < 0) _exit(2);
  if (sink > STDERR_FILENO) close(sink);
  /* An inherited DEBUG/ERR/EXIT trap must never run user commands in this
   * parse-only child, including on a parser error or non-local exit. */
  function_trace_mode = error_trace_mode = 0;
  restore_original_signals();
  initialize_traps();
  signal(SIGALRM, SIG_DFL);
  alarm(1);
  if (setjmp(top_level) != 0) _exit(2);
  source_copy = strdup(source);
  plan_copy = strdup(plan);
  if (!source_copy || !plan_copy) _exit(2);
  if (parse_and_execute(source_copy, "ShellSpan source validation", flags) != 0) _exit(2);
  if (parse_and_execute(plan_copy, "ShellSpan plan validation", flags) != 0) _exit(2);
  _exit(0);
}
static void validate_pending_input(void) {
  uint64_t request, budget, start;
  char *source = NULL, *plan = NULL;
  sigset_t blocked, previous;
  struct sigaction child_action;
  pid_t child = -1, waited;
  int status = 0, valid = 0, masked = 0;
  if (!p0_pending_validation(&request, &source, &plan, &budget)) return;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGCHLD);
  sigaddset(&blocked, SIGINT);
  /* Bash must not reap this private child or jump across a Rust completion
   * frame. Restore the exact parent mask only after all Rust calls return. */
  if (sigprocmask(SIG_BLOCK, &blocked, &previous) == 0) {
    masked = 1;
    start = validation_clock_ms();
    /* Keep the same interactive grammar as builtin eval. Refuse a child
     * lifecycle that would auto-reap: its PID must remain owned until wait. */
    if (budget > 0 && start != 0 && sigaction(SIGCHLD, NULL, &child_action) == 0 &&
        child_action.sa_handler != SIG_IGN && !(child_action.sa_flags & SA_NOCLDWAIT)) child = fork();
    if (child == 0) {
      sigprocmask(SIG_SETMASK, &previous, NULL);
      parse_only_child(source, plan);
    }
    if (child > 0) {
      for (;;) {
        waited = waitpid(child, &status, WNOHANG);
        if (waited == child) {
          valid = WIFEXITED(status) && WEXITSTATUS(status) == 0;
          break;
        }
        if (waited < 0 && errno != EINTR) break;
        if (validation_clock_ms() == 0 || validation_clock_ms() - start >= budget) break;
        struct timespec delay = {0, 1000000};
        nanosleep(&delay, NULL);
      }
      if (waited == 0 || (waited < 0 && errno == EINTR)) {
        kill(child, SIGKILL);
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
      }
    }
  }
  p0_validation_text_free(source);
  p0_validation_text_free(plan);
  if (p0_validation_complete(request, valid)) p0_editor_ready(p0_bindings_valid());
  if (masked) sigprocmask(SIG_SETMASK, &previous, NULL);
}
static int event_tick(void) {
  int saved_errno = errno;
#if RL_READLINE_VERSION >= 0x0700
  if (rl_signal_event_hook) {
    if (append_display_active) display_mode(0);
    (*rl_signal_event_hook)();
    if (append_display_active) display_mode(1);
  }
#endif
  p0_tick();
  validate_pending_input();
  errno = saved_errno;
  return 0;
}
void p0_refresh_input(void) {
  if (!installed_input) return;
  if (p0_needs_tick()) rl_event_hook = event_tick;
  else if (in_service_key) { rl_event_hook = saved_hook; finish_display(); }
  else if (!service_queued) {
    /* Do not remove a hook from inside rl_read_key's hook loop: leave it by
     * dispatching an inert native service key, never a character or Enter. */
    service_queued = 1;
    rl_stuff_char(0x18);
    rl_stuff_char('b');
  }
}
static int service_key(int count, int key) {
  (void)count; (void)key;
  in_service_key = 1;
  service_queued = 0;
  p0_service();
  event_tick();
  p0_refresh_input();
  in_service_key = 0;
  return 0;
}
static int finish_key(int count, int key) {
  (void)count; (void)key;
  in_service_key = 1;
  service_queued = 0;
  event_tick();
  p0_refresh_input();
  in_service_key = 0;
  return 0;
}
int p0_install_input(void) {
  /* Other custom input providers/event hooks need separate compatibility
   * evidence. Do not replace them just because the shell says Bash. */
  if (rl_getc_function != rl_getc || rl_event_hook != NULL) return 1;
  /* Captured before readline() installs its deferred input signal handler.
   * The fixed Bash widget needs Bash's normal signal semantics while it runs
   * builtins, then returns to the exact Readline disposition and mask. */
  if (sigaction(SIGINT,NULL,&control_shell_int)!=0
      || control_shell_int.sa_handler==SIG_DFL || control_shell_int.sa_handler==SIG_IGN) return 1;
  saved_hook = rl_event_hook;
  owned_map = rl_get_keymap();
  {
    int kind;
    control_bash_function=rl_function_of_keyseq("\x18\x1f",owned_map,&kind);
    if (!control_bash_function || kind!=ISFUNC) return 1;
  }
  control_sink=open_readline_sink();
  if (!control_sink) return 1;
  setvbuf(control_sink,NULL,_IONBF,0);
  if (rl_bind_keyseq("\x18\x1f",control_dispatch_key)!=0) return 1;
  saved_pre_input = rl_pre_input_hook;
  if (rl_bind_keyseq("\x18\x1e", service_key) != 0) return 1;
  if (rl_bind_keyseq("\030b", finish_key) != 0) return 1;
  installed_input = 1;
  rl_pre_input_hook = editor_ready;
  return 0;
}
void p0_finish_input(void) {
  if (installed_input && rl_event_hook == event_tick) rl_event_hook = saved_hook;
  finish_display();
}
void p0_uninstall_input(void) {
  p0_finish_input();
  finish_handoff_display();
  finish_control_redraw();
  installed_input = 0;
  if (rl_pre_input_hook == editor_ready) rl_pre_input_hook = saved_pre_input;
  {
    int kind;
    if (rl_function_of_keyseq("\x18\x1e",owned_map,&kind)==service_key) rl_bind_keyseq_in_map("\x18\x1e",NULL,owned_map);
    if (rl_function_of_keyseq("\030a",owned_map,&kind)==p0_commit_key) rl_bind_keyseq_in_map("\030a",NULL,owned_map);
    if (rl_function_of_keyseq("\030b",owned_map,&kind)==finish_key) rl_bind_keyseq_in_map("\030b",NULL,owned_map);
    if (rl_function_of_keyseq("\x18\x1f",owned_map,&kind)==control_dispatch_key) rl_bind_keyseq_in_map("\x18\x1f",NULL,owned_map);
  }
  if (control_sink) { fclose(control_sink); control_sink=NULL; }
}

static int p0_builtin(WORD_LIST *args) {
  if (!args || !args->word || !args->word->word) return 2;
  if (args->next && args->next->word->word[0]) return 1;
  /* Bash4.1 does not invoke the newer load hook. Check before touching its
   * input provider or opening the private control connection on every target. */
  if (!p0_builtin_load("ss_native_input")) return 1;
  return p0_start(args->word->word, args->next && args->next->next ? args->next->next->word->word : NULL);
}
static int native_display_abi_builtin(WORD_LIST *args) {
  return args ? 2 : (native_display_abi_available() ? 0 : 1);
}
static int p0_result_builtin(WORD_LIST *args) {
  if (!args || !args->next) return 2;
  return p0_status(atoi(args->word->word), args->next->word->word);
}
static int p0_begin_builtin(WORD_LIST *args) {
  /* This fixed-plan builtin runs only after readline() returned and the
   * parent's parser completed. Restore before p0_begin releases pending INT. */
  finish_handoff_display();
  return args ? p0_begin(atoi(args->word->word)) : 2;
}
static int p0_child_builtin(WORD_LIST *args) {
  (void)args;
  return p0_control_closed();
}
static int native_job_builtin(WORD_LIST *args) {
  if (!args || !args->next || !args->next->next || args->next->next->next) return 2;
  return ss_native_job(args->word->word, args->next->word->word, args->next->next->word->word);
}
static int native_dispatch_free_builtin(WORD_LIST *args) {
  int kind;
  if (args) return 2;
  return rl_function_of_keyseq("\x18\x1f",rl_get_keymap(),&kind) ? 1 : 0;
}
static int native_control_access_builtin(WORD_LIST *args) { return args ? 2 : ss_native_control_access(); }
static int native_control_begin_builtin(WORD_LIST *args) {
  if (!args || !args->next || !args->next->next || args->next->next->next) return 2;
  int result=ss_native_control_begin(args->word->word,args->next->word->word,args->next->next->word->word);
  /* Unblock only after Rust has returned: Bash may nonlocally unwind on INT. */
  if (result==0) control_enable_interrupt();
  return result;
}
static int native_control_end_builtin(WORD_LIST *args) {
  if (!args || !args->next || args->next->next) return 2;
  return ss_native_control_end(atoi(args->word->word),args->next->word->word);
}
void p0_builtin_unload(char *name) { (void)name; p0_stop(); }
static char *const documentation[] = { "ShellSpan native Readline input protocol.", 0 };
int ss_native_input_builtin_load(char *name) { return p0_builtin_load(name); }
void ss_native_input_builtin_unload(char *name) { p0_builtin_unload(name); }
struct builtin ss_native_input_struct = { "ss_native_input", p0_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input private-socket", 0 };
struct builtin ss_native_input_display_abi_struct = { "ss_native_input_display_abi", native_display_abi_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_display_abi", 0 };
struct builtin ss_native_input_status_struct = { "ss_native_input_status", p0_result_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_status status cwd", 0 };
struct builtin ss_native_input_begin_struct = { "ss_native_input_begin", p0_begin_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_begin status", 0 };
struct builtin ss_native_input_child_closed_struct = { "ss_native_input_child_closed", p0_child_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_child_closed", 0 };
struct builtin ss_native_input_job_struct = { "ss_native_input_job", native_job_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_job handle state status", 0 };
struct builtin ss_native_input_dispatch_free_struct = { "ss_native_input_dispatch_free", native_dispatch_free_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_dispatch_free", 0 };
struct builtin ss_native_input_control_access_struct = { "ss_native_input_control_access", native_control_access_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_control_access", 0 };
struct builtin ss_native_input_control_begin_struct = { "ss_native_input_control_begin", native_control_begin_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_control_begin handle action nonce", 0 };
struct builtin ss_native_input_control_end_struct = { "ss_native_input_control_end", native_control_end_builtin, BUILTIN_ENABLED,
  documentation, "ss_native_input_control_end status cwd", 0 };

static int native_tty_stream(FILE *stream) {
  struct stat original, target;
  return stream && isatty(fileno(stream)) && fstat(STDIN_FILENO,&original)==0
      && fstat(fileno(stream),&target)==0 && original.st_rdev==target.st_rdev;
}
int p0_native_protocol_supported(void) {
  const char *codeset=nl_langinfo(CODESET);
#ifdef __GLIBC__
  const char *glibc = gnu_get_libc_version();
#ifdef SHELLSPAN_MIN_GLIBC
  if (strncmp(glibc, "2.", 2) || strverscmp(glibc, SHELLSPAN_MIN_GLIBC) < 0) return 0;
#else
  if (strcmp(glibc, "2.36")) return 0;
#endif
#endif
  return native_prompt_columns && codeset && (!strcmp(codeset,"UTF-8") || !strcmp(codeset,"UTF8"))
      && rl_editing_mode == 1 && saved_pre_input == NULL
      && rl_pre_input_hook == editor_ready && native_tty_stream(rl_instream) && native_tty_stream(rl_outstream)
      && rl_redisplay_function == rl_redisplay;
}
void p0_native_display_reset(void) {
  display_mode(0);
}
