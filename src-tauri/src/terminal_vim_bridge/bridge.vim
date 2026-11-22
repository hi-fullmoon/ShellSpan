" Loaded explicitly in the existing editor with :source $SHELLSPAN_VIM_BRIDGE.
" Neither the request text nor an editor response travels through the PTY.
let s:root = expand('<sfile>:p:h')
let s:limit = 1048576
let s:frame_limit = 262144

function! s:fail(code) abort
    throw 'ShellSpan:' . a:code
endfunction

function! s:process(pid) abort
    let proc = '/proc/' . a:pid
    let stat = readfile(proc . '/stat', '', 1)[0]
    " The process name is parenthesized and can itself contain spaces or ')'.
    let fields = matchlist(stat, '\v^\d+ \((.*)\) \S+ (\d+) (\d+) \d+ (\d+) (-?\d+) ')
    let uid = matchstr(join(readfile(proc . '/status'), "\n"), '\m\<Uid:\s*\d\+\s\+\zs\d\+')
    return {'name': fields[1], 'parent': str2nr(fields[2]), 'group': fields[3],
                \ 'tty': str2nr(fields[4]), 'foreground': fields[5], 'uid': uid}
endfunction

function! s:foreground() abort
    if $SSH_TTY !~# '\m^/dev/pts/\d\+$'
        return 0
    endif
    try
        let process = s:process(getpid())
        let uid = readfile(s:root . '/uid', '', 1)[0]
        if process.uid !=# uid
            return 0
        endif
        if process.tty != 0
            return process.group ==# process.foreground
                        \ && resolve('/proc/' . getpid() . '/fd/0') ==# $SSH_TTY
        endif
        if has('nvim') && process.parent > 1 && process.foreground ==# '-1'
            " Neovim's TUI can own the SSH PTY while its embedded editor runs
            " in a separate session. Check the direct TUI parent and device.
            let ui = s:process(process.parent)
            let device = luaeval('(vim.uv or vim.loop).fs_stat(_A).rdev', $SSH_TTY)
            return ui.name ==# process.name && ui.uid ==# uid
                        \ && ui.tty == device && ui.group ==# ui.foreground
        endif
    catch
        return 0
    endtry
    return 0
endfunction

function! s:inside(path, root) abort
    return empty(a:root) || a:root ==# '/' || stridx(a:path, a:root . '/') == 0
endfunction

function! s:file_path(root) abort
    let path = simplify(expand('%:p'))
    if empty(path) || &l:buftype !=# '' || path =~# '[[:cntrl:]]'
                \ || resolve(path) !=# path || getftype(path) !=# 'file'
                \ || !s:inside(path, a:root) || !filereadable(path)
        call s:fail('unsupportedFile')
    endif
    if &encoding !=# 'utf-8' || (&l:fileencoding !=# '' && &l:fileencoding !=# 'utf-8')
                \ || &l:binary || index(['unix', 'dos'], &l:fileformat) < 0
                \ || getfsize(path) > s:limit || line2byte(line('$') + 1) > s:limit
        call s:fail('unsupportedFile')
    endif
    return path
endfunction

function! s:state(root) abort
    if s:suspended || !s:foreground() || mode(1) !=# 'n' || !empty(getcmdwintype())
        call s:fail('editorNotReady')
    endif
    let path = s:file_path(a:root)
    return {'path': path, 'windowId': win_getid(), 'bufferId': bufnr(),
                \ 'changedTick': b:changedtick, 'line': line('.'), 'byteColumn': col('.'),
                \ 'lineCount': line('$'), 'modified': &l:modified ? v:true : v:false,
                \ 'modifiable': &l:modifiable ? v:true : v:false,
                \ 'readOnly': &l:readonly ? v:true : v:false}
endfunction

function! s:disk_digest(path) abort
    if getftype(a:path) !=# 'file' || resolve(a:path) !=# a:path || getfsize(a:path) > s:limit
        call s:fail('unsupportedFile')
    endif
    let lines = readfile(a:path, 'b')
    if getfsize(a:path) > s:limit || !empty(filter(copy(lines), {_, line -> stridx(line, "\n") >= 0}))
        call s:fail('unsupportedFile')
    endif
    return sha256(join(lines, "\n"))
endfunction

function! s:buffer_digest(for_write) abort
    let lines = getline(1, '$')
    if !empty(filter(copy(lines), {_, line -> stridx(line, "\n") >= 0}))
        call s:fail('unsupportedFile')
    endif
    let newline = &l:fileformat ==# 'dos' ? "\r\n" : "\n"
    let bytes = join(lines, newline)
    " Vim represents both an empty buffer and a one-line blank file as [''].
    if (lines !=# [''] || wordcount().bytes > 0)
                \ && (&l:endofline || (a:for_write && &l:fixendofline))
        let bytes .= newline
    endif
    return sha256((&l:bomb ? nr2char(0xfeff) : '') . bytes)
endfunction

function! s:baseline(buffer) abort
    return get(s:baselines, a:buffer, {})
endfunction

function! s:record_baseline(buffer, path, disk) abort
    let s:baselines[a:buffer] = {'path': a:path, 'digest': a:disk}
    if has_key(s:conflicts, a:buffer)
        call remove(s:conflicts, a:buffer)
    endif
endfunction

function! s:forget_baseline(buffer) abort
    if has_key(s:baselines, a:buffer)
        call remove(s:baselines, a:buffer)
    endif
    if has_key(s:conflicts, a:buffer)
        call remove(s:conflicts, a:buffer)
    endif
endfunction

function! s:remember_current(buffer, file) abort
    if a:buffer != bufnr()
        return
    endif
    try
        let path = s:file_path('')
        if !empty(a:file) && simplify(fnamemodify(a:file, ':p')) !=# path
            return
        endif
        let digest = s:disk_digest(path)
        if s:buffer_digest(0) ==# digest
            call s:record_baseline(a:buffer, path, digest)
        endif
    catch
        " These events also run during ordinary manual editing of unsupported files.
    endtry
endfunction

function! s:snapshot(state, root, owner) abort
    let s:sequence += 1
    let s:observed = a:state
    let s:observed.id = s:instance . '-' . s:sequence
    let s:observed.root = a:root
    let s:observed.baseline = s:baseline(a:state.bufferId)
    let s:observed.owner = a:owner
    let s:observed.windowGeneration = s:window_generation
    let s:observed.format = [&l:fileformat, &l:fileencoding, &l:bomb, &l:endofline, &l:fixendofline]
    let snapshot = copy(s:observed)
    call remove(snapshot, 'baseline')
    call remove(snapshot, 'root')
    call remove(snapshot, 'owner')
    call remove(snapshot, 'windowGeneration')
    call remove(snapshot, 'format')
    return snapshot
endfunction

function! s:assert_snapshot(request) abort
    if empty(s:observed) || a:request.snapshotId !=# s:observed.id
                \ || a:request.path !=# s:observed.path || a:request.root !=# s:observed.root
                \ || a:request.owner !=# s:observed.owner
                \ || s:observed.windowGeneration != s:window_generation
                \ || s:observed.format !=# [&l:fileformat, &l:fileencoding, &l:bomb, &l:endofline, &l:fixendofline]
        call s:fail('snapshotChanged')
    endif
    let current = s:state(a:request.root)
    for field in ['path', 'windowId', 'bufferId', 'changedTick', 'modified', 'modifiable', 'readOnly']
        if current[field] !=# s:observed[field]
            call s:fail('snapshotChanged')
        endif
    endfor
    if get(a:request, 'position', '') ==# 'cursor'
                \ && (current.line != s:observed.line || current.byteColumn != s:observed.byteColumn)
        call s:fail('snapshotChanged')
    endif
    return current
endfunction

function! s:insert(state, position, text) abort
    if !a:state.modifiable || &l:undolevels == -1 || (&g:undolevels < 0 && &l:undolevels == -123456)
                \ || line2byte(line('$') + 1) + strlen(a:text) > s:limit
        call s:fail('notEditable')
    endif
    if a:position ==# 'start'
        let row = 1
        let column = 0
    elseif a:position ==# 'end'
        let row = line('$')
        let column = strlen(getline(row))
    else
        let row = a:state.line
        let column = a:state.byteColumn - 1
    endif
    let original = getline(row)
    if column > strlen(original) || (column < strlen(original) && char2nr(strpart(original, column, 1), 1) >= 128
                \ && char2nr(strpart(original, column, 1), 1) <= 191)
        call s:fail('unsupportedCursor')
    endif
    let lines = split(a:text, "\n", 1)
    let lines[0] = strpart(original, 0, column) . lines[0]
    let lines[-1] .= strpart(original, column)
    let tick = b:changedtick
    noautocmd let &g:undolevels = &g:undolevels
    if lines[0] !=# original && setline(row, lines[0]) != 0
        call s:fail('notEditable')
    endif
    if len(lines) > 1
        if b:changedtick != tick
            undojoin
        endif
        if append(row, lines[1:]) != 0
            call s:fail('insertUnverified')
        endif
    endif
    noautocmd let &g:undolevels = &g:undolevels
    if getline(row, row + len(lines) - 1) !=# lines
        call s:fail('insertUnverified')
    endif
endfunction

function! s:file_changed() abort
    let s:conflicts[str2nr(expand('<abuf>'))] = 1
    let v:fcs_choice = ''
endfunction

function! s:check_disk(state) abort
    let baseline = s:observed.baseline
    if empty(baseline) || baseline.path !=# a:state.path
        call s:fail('diskBaselineUnavailable')
    endif
    if baseline !=# s:baseline(a:state.bufferId)
        call s:fail('snapshotChanged')
    endif
    call s:check_links(a:state.path)
    if s:disk_digest(a:state.path) !=# baseline.digest || has_key(s:conflicts, a:state.bufferId)
        let s:conflicts[a:state.bufferId] = 1
        call s:fail('diskChanged')
    endif
    if exists('#FileChangedShell')
        call s:fail('unsupportedChangeHook')
    endif
    augroup ShellSpanVimBridgeCheck
        autocmd!
        autocmd FileChangedShell * call <SID>file_changed()
    augroup END
    try
        execute 'checktime ' . a:state.bufferId
    finally
        autocmd! ShellSpanVimBridgeCheck
    endtry
    if has_key(s:conflicts, a:state.bufferId)
        call s:fail('diskChanged')
    endif
endfunction

function! s:check_links(path) abort
    if has('nvim')
        let stat = luaeval('(vim.uv or vim.loop).fs_lstat(_A)', a:path)
        let links = get(stat is v:null ? {} : stat, 'nlink', 0)
    else
        let job = job_start(['stat', '-c', '%h', '--', a:path],
                    \ {'in_io': 'null', 'err_io': 'null', 'out_mode': 'nl'})
        let reply = job_status(job) ==# 'fail' ? '' : ch_read(job, {'timeout': 500})
        if empty(reply) && job_status(job) ==# 'run'
            call job_stop(job)
        endif
        let links = reply =~# '\m^\d\+$' ? str2nr(reply) : 0
    endif
    if links > 1
        call s:fail('multipleHardLinks')
    elseif links != 1
        call s:fail('unsupportedFile')
    endif
endfunction

function! s:save(request, state) abort
    if a:state.readOnly || !&write
        call s:fail('readOnly')
    endif
    call s:check_disk(a:state)
    call s:assert_snapshot(a:request)
    let expected = s:buffer_digest(1)
    try
        silent write
        let disk = s:disk_digest(a:state.path)
        let current = s:state(a:request.root)
    catch
        call s:fail('saveUnverified')
    endtry
    if disk !=# expected || current.modified || current.bufferId != a:state.bufferId
                \ || current.windowId != a:state.windowId || current.path !=# a:state.path
        call s:fail('saveUnverified')
    endif
    call s:record_baseline(current.bufferId, current.path, disk)
    return current
endfunction

function! s:check_close(state) abort
    if a:state.modified || !empty(getbufinfo({'bufmodified': 1}))
        call s:fail('unsavedChanges')
    endif
    for buf in getbufinfo()
        if getbufvar(buf.bufnr, '&buftype') ==# 'terminal'
            call s:fail('editorNotReady')
        endif
    endfor
endfunction

function! s:finish_close(timer) abort
    if s:suspended || !s:foreground() || mode(1) !=# 'n' || !empty(getcmdwintype())
                \ || !empty(getbufinfo({'bufmodified': 1}))
        return
    endif
    for buf in getbufinfo()
        if getbufvar(buf.bufnr, '&buftype') ==# 'terminal'
            return
        endif
    endfor
    let saved_confirm = &confirm
    let &confirm = 0
    try
        silent quitall
    catch
        let &confirm = saved_confirm
    endtry
endfunction

function! s:dispatch(request) abort
    if a:request.operation ==# 'inspect'
        let current = s:state(a:request.root)
        if !current.modified && empty(s:baseline(current.bufferId))
            call s:remember_current(current.bufferId, '')
        endif
        return {'status': 'observed', 'snapshot': s:snapshot(current, a:request.root, a:request.owner)}
    endif
    if a:request.operation ==# 'prepare'
        let current = s:assert_snapshot(a:request)
        if get(a:request, 'action', '') ==# 'close'
            call s:check_close(current)
        endif
        let s:prepared = {'request': a:request, 'started': reltime()}
        return {'status': 'prepared'}
    endif
    if a:request.operation !=# 'commit' || empty(s:prepared)
                \ || a:request.preparedId !=# s:prepared.request.id
                \ || reltimefloat(reltime(s:prepared.started)) > 5.0
        call s:fail('operationExpired')
    endif
    let request = s:prepared.request
    let s:prepared = {}
    let current = s:assert_snapshot(request)
    if request.action ==# 'insert'
        try
            call s:insert(current, request.position, request.text)
            let updated = s:state(request.root)
        catch /^ShellSpan:\(notEditable\|unsupportedCursor\)$/
            throw v:exception
        catch
            call s:fail('insertUnverified')
        endtry
        let reply = {'status': 'inserted', 'snapshot': s:snapshot(updated, request.root, request.owner)}
    elseif request.action ==# 'save'
        let updated = s:save(request, current)
        let reply = {'status': 'saved', 'snapshot': s:snapshot(updated, request.root, request.owner)}
    elseif request.action ==# 'close'
        call s:check_close(current)
        let snapshot = s:snapshot(current, request.root, request.owner)
        let s:observed = {}
        call timer_start(20, function('s:finish_close'))
        let reply = {'status': 'closed', 'snapshot': snapshot}
    else
        call s:fail('unsupportedOperation')
    endif
    return reply
endfunction

function! s:send(message) abort
    let line = json_encode(extend({'version': 1, 'instance': s:instance}, a:message)) . "\n"
    if has('nvim')
        return chansend(s:job, line) > 0
    endif
    call ch_sendraw(job_getchannel(s:job), line)
    return 1
endfunction

function! s:receive(line) abort
    if strlen(a:line) > s:frame_limit
        return
    endif
    try
        let request = json_decode(a:line)
        if request.version != 1 || request.instance !=# s:instance || request.id !~# '^\x\{32}$'
            return
        endif
    catch
        return
    endtry
    try
        let result = s:dispatch(request)
    catch /^ShellSpan:/
        let code = split(v:exception, ':')[1]
        if index(['saveUnverified', 'insertUnverified'], code) >= 0
            let s:observed = {}
            let result = {'status': 'uncertain', 'code': code}
        else
            let result = {'status': 'rejected', 'code': code}
        endif
    catch
        let result = {'status': request.operation ==# 'commit' ? 'uncertain' : 'rejected',
                    \ 'code': 'editorError'}
        let s:observed = {}
    endtry
    call s:send(extend({'type': 'reply', 'id': request.id}, result))
endfunction

function! s:on_vim_stdout(channel, line) abort
    call s:receive(a:line)
endfunction

function! s:on_nvim_stdout(job, lines, event) abort
    if !empty(a:lines)
        let a:lines[0] = s:partial . a:lines[0]
        let s:partial = remove(a:lines, -1)
        if strlen(s:partial) > s:frame_limit
            call s:stop()
            return
        endif
        for line in a:lines
            call s:receive(line)
        endfor
    endif
endfunction

function! s:announce(timer) abort
    if !exists('s:timer')
        return
    endif
    if !isdirectory(s:root)
        call s:stop()
        return
    endif
    if !empty(s:prepared) && reltimefloat(reltime(s:prepared.started)) > 5.0
        let s:prepared = {}
    endif
    let attached = !s:suspended && s:foreground()
    if attached != s:attached
        if s:send({'type': attached ? 'attached' : 'detached',
                    \ 'editor': has('nvim') ? 'neovim' : 'vim'})
            let s:attached = attached
            let s:observed = {}
            let s:prepared = {}
        endif
    endif
endfunction

function! s:suspend() abort
    let s:suspended = 1
    let s:observed = {}
    let s:prepared = {}
    call s:announce(0)
endfunction

function! s:resume() abort
    let s:suspended = 0
    let s:attached = -1
    call s:announce(0)
endfunction

function! s:on_exit(...) abort
    if exists('s:timer')
        call timer_stop(s:timer)
        unlet s:timer
    endif
    let s:job = 0
endfunction

function! s:stop() abort
    if exists('s:timer')
        call timer_stop(s:timer)
        unlet s:timer
    endif
    if exists('s:job') && s:job isnot 0
        if s:attached == 1
            try
                call s:send({'type': 'detached'})
            catch
            endtry
        endif
        if has('nvim')
            call chanclose(s:job, 'stdin')
        else
            call ch_close_in(job_getchannel(s:job))
        endif
    endif
endfunction

if exists('s:timer')
    finish
endif
if expand('<sfile>:p') !=# $SHELLSPAN_VIM_BRIDGE || !exists('*sha256')
            \ || !exists('*timer_start') || (!has('nvim') && !has('job'))
            \ || !filereadable(s:root . '/uid') || !s:foreground()
    echoerr 'ShellSpan Vim bridge is unavailable in this editor or SSH terminal'
    finish
endif
let s:sequence = 0
let s:window_generation = 0
let s:instance = sha256(string(reltime()) . ':' . getpid() . ':' . tempname())
let s:observed = {}
let s:prepared = {}
let s:baselines = {}
let s:conflicts = {}
let s:partial = ''
let s:attached = -1
let s:suspended = 0
let s:args = ['/bin/sh', s:root . '/relay.sh', s:root, 'editor']
if has('nvim')
    let s:job = jobstart(s:args, {'on_stdout': function('s:on_nvim_stdout'), 'on_exit': function('s:on_exit')})
    let s:started = s:job > 0
else
    let s:job = job_start(s:args, {'out_mode': 'nl', 'out_cb': function('s:on_vim_stdout'),
                \ 'exit_cb': function('s:on_exit'), 'err_io': 'null', 'stoponexit': ''})
    let s:started = job_status(s:job) ==# 'run'
endif
if !s:started
    echoerr 'ShellSpan could not attach its editor bridge'
    finish
endif
let s:timer = timer_start(200, function('s:announce'), {'repeat': -1})
call s:announce(s:timer)
augroup ShellSpanVimBridge
    autocmd!
    autocmd VimLeavePre * call <SID>stop()
    autocmd VimSuspend * call <SID>suspend()
    autocmd VimResume * call <SID>resume()
    autocmd BufReadPre,BufFilePost,BufWipeout * call <SID>forget_baseline(str2nr(expand('<abuf>')))
    autocmd BufReadPost,BufWritePost * call <SID>remember_current(str2nr(expand('<abuf>')), expand('<afile>'))
    autocmd BufLeave,WinLeave * let s:window_generation += 1
augroup END
if !&l:modified
    call s:remember_current(bufnr(), '')
endif
