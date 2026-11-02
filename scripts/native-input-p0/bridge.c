/* Experimental loadable builtin; compile against the target Bash's headers.
 * No Bash evaluator, parser, or private Readline symbols are used. */
#include "builtins.h"
#include <stdlib.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <readline/readline.h>
#include <dlfcn.h>
#include <sys/ioctl.h>
extern int p0_start(const char *path, const char *shell_version);
extern int p0_status(int status, const char *cwd);
extern void p0_stop(void);
extern int p0_begin(int status);
extern int p0_control_closed(void);
extern int p0_tick(void);
extern int p0_needs_tick(void);
extern void p0_editor_ready(int bindings_valid);
extern int p0_commit_key(int count, int key);
extern void p0_service(void);
int p0_builtin_load(char *name) {
  static void *image_pin;
  Dl_info information;
  (void)name;
  if (image_pin) return 1;
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
static int handoff_display_active;
static rl_voidfunc_t *handoff_saved_redisplay;
static void handoff_display(void) {}
static void finish_handoff_display(void) {
  if (handoff_display_active && rl_redisplay_function == handoff_display)
    rl_redisplay_function = handoff_saved_redisplay;
  handoff_display_active = 0;
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
   * The actual editor buffer is the only text source. No pixel/cell/cursor
   * model, terminal clear, screen replay or full-draft restore is involved.
   * UTF-8 bytes remain native; CR uses Readline's own visible-control helper. */
  for (size_t index=displayed_bytes;index<length;index++) {
    unsigned char character=(unsigned char)rl_line_buffer[index];
    if (character=='\r') fputs("^M",rl_outstream);
    else fputc(character,rl_outstream);
  }
  fflush(rl_outstream);
  displayed_bytes = length;
}
int p0_begin_append_display(void) {
  if (rl_redisplay_function != rl_redisplay) return 1;
  saved_redisplay=rl_redisplay_function;
  displayed_bytes=0;
  append_display_active=1;
  rl_redisplay_function=append_display;
  return 0;
}
void p0_paint_line(void) { (*rl_redisplay_function)(); }
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
static int installed_input, in_service_key, service_queued;
static int service_key(int count, int key);
static int finish_key(int count, int key);
int p0_bindings_valid(void) {
  int kind;
  return rl_function_of_keyseq("\x18\x1e", rl_get_keymap(), &kind) == service_key
      && rl_function_of_keyseq("\030b", rl_get_keymap(), &kind) == finish_key
      && rl_function_of_keyseq("\030a", rl_get_keymap(), &kind) == p0_commit_key;
}
static int editor_ready(void) {
  /* A fresh native input line is also a safe fallback restoration boundary. */
  finish_handoff_display();
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
static int event_tick(void) {
  int saved_errno = errno;
  p0_tick();
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
  saved_hook = rl_event_hook;
  owned_map = rl_get_keymap();
  saved_pre_input = rl_pre_input_hook;
  if (rl_bind_keyseq("\x18\x1e", service_key) != 0) return 1;
  if (rl_bind_keyseq("\030b", finish_key) != 0) return 1;
  installed_input = 1;
  rl_pre_input_hook = editor_ready;
  return 0;
}
void p0_finish_input(void) {
  if (installed_input) rl_event_hook = saved_hook;
  finish_display();
}
void p0_uninstall_input(void) {
  p0_finish_input();
  finish_handoff_display();
  installed_input = 0;
  if (rl_pre_input_hook == editor_ready) rl_pre_input_hook = saved_pre_input;
  rl_bind_keyseq_in_map("\x18\x1e", NULL, owned_map);
  rl_bind_keyseq_in_map("\030a", NULL, owned_map);
  rl_bind_keyseq_in_map("\030b", NULL, owned_map);
}

static int p0_builtin(WORD_LIST *args) {
  if (!args || !args->word || !args->word->word) return 2;
  if (args->next && args->next->word->word[0]) return 1;
  return p0_start(args->word->word, args->next && args->next->next ? args->next->next->word->word : NULL);
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
void p0_builtin_unload(char *name) { (void)name; p0_stop(); }
static char *const documentation[] = { "P0 isolated Readline feasibility bridge.", 0 };
struct builtin p0_struct = { "p0", p0_builtin, BUILTIN_ENABLED,
  documentation, "p0 private-socket", 0 };
struct builtin p0_result_struct = { "p0_result", p0_result_builtin, BUILTIN_ENABLED,
  documentation, "p0_result status cwd", 0 };
struct builtin p0_begin_struct = { "p0_begin", p0_begin_builtin, BUILTIN_ENABLED,
  documentation, "p0_begin status", 0 };
struct builtin p0_child_closed_struct = { "p0_child_closed", p0_child_builtin, BUILTIN_ENABLED,
  documentation, "p0_child_closed", 0 };

int p0_native_protocol_supported(void) { return 0; }
void p0_native_display_reset(void) {
  const char *protocol = getenv("SHELLSPAN_NATIVE_INPUT_PROTOCOL");
  if (protocol && strcmp(protocol, "1") == 0) {
    FILE *stream = rl_outstream ? rl_outstream : stdout;
    fputs("\033]1337;SetUserVar=ShellSpanNativeInputV1=MA==\007", stream);
    fflush(stream);
  }
}
