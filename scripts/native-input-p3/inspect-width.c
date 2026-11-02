#define _XOPEN_SOURCE 700
#include <locale.h>
#include <wchar.h>
#include <wctype.h>
#include <stdio.h>
int main(void){
    const char *locale=setlocale(LC_ALL,"");if(!locale)return 1;
    printf("{\"locale\":\"%s\",\"combiningAcuteWidth\":%d,\"zwjWidth\":%d,\"zwjPrintable\":%s,\"womanWidth\":%d,\"skinModifierWidth\":%d,\"laptopWidth\":%d,\"womanGraph\":%s,\"modifierGraph\":%s,\"modifierPrintable\":%s}\n",locale,wcwidth(0x301),wcwidth(0x200d),iswprint(0x200d)?"true":"false",wcwidth(0x1f469),wcwidth(0x1f3fd),wcwidth(0x1f4bb),iswgraph(0x1f469)?"true":"false",iswgraph(0x1f3fd)?"true":"false",iswprint(0x1f3fd)?"true":"false");
    return 0;
}
