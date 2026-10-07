#include <dlfcn.h>
#include <stdio.h>

/* Read-only symbol inventory. Never creates a client or registers a policy. */
int main(void) {
    void *library = dlopen("/usr/lib/libEndpointSecurity.dylib", RTLD_LOCAL | RTLD_NOW);
    if (library == NULL) {
        fputs("EndpointSecurity library could not be loaded\n", stderr);
        return 1;
    }
    const char *symbols[] = {
        "es_new_client",
        "es_new_descendants_client",
        "es_set_deadline_miss_mode",
    };
    for (unsigned int i = 0; i < sizeof(symbols) / sizeof(symbols[0]); ++i) {
        printf("%s=%s\n", symbols[i], dlsym(library, symbols[i]) ? "present" : "absent");
    }
    return dlclose(library) == 0 ? 0 : 1;
}
