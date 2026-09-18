FROM alpine:3.22

RUN apk add --no-cache openssh python3 bash zsh \
    && adduser -D -s /bin/bash shellspan \
    && adduser -D -s /bin/zsh shellspan-zsh \
    && adduser -D -s /bin/sh shellspan-sh \
    && echo 'shellspan:shellspan-e2e' | chpasswd \
    && echo 'shellspan-zsh:shellspan-e2e' | chpasswd \
    && echo 'shellspan-sh:shellspan-e2e' | chpasswd \
    && mkdir -p /home/shellspan/upload /run/sshd /var/lib/shellspan-m6 \
    && printf 'inactive\n' > /var/lib/shellspan-m6/service.state \
    && printf '0\n' > /var/lib/shellspan-m6/restart.count \
    && printf 'root-only-fixture-secret\n' > /root/shellspan-m6-root-only \
    && chmod 600 /root/shellspan-m6-root-only \
    && chown -R shellspan:shellspan /home/shellspan /var/lib/shellspan-m6

RUN printf '%s\n' \
      'export SHELLSPAN_BASH_PROFILE_ORDER="${SHELLSPAN_BASH_PROFILE_ORDER-}:bash_profile"' \
      'export SHELLSPAN_BASH_PROFILE_COUNT=$(( ${SHELLSPAN_BASH_PROFILE_COUNT:-0} + 1 ))' \
      'export LANG=C.UTF-8' \
      'printf "shellspan-bash-login-marker\\n"' \
      'source "$HOME/.bashrc"' \
      > /home/shellspan/.bash_profile \
    && printf '%s\n' \
      'export SHELLSPAN_BASH_PROFILE_ORDER="${SHELLSPAN_BASH_PROFILE_ORDER-}:bashrc"' \
      'export SHELLSPAN_BASH_RC_COUNT=$(( ${SHELLSPAN_BASH_RC_COUNT:-0} + 1 ))' \
      'alias shellspan_fixture_alias="printf bash-alias-ready"' \
      'shellspan_fixture_function() { printf bash-function-ready; }' \
      'HISTFILE="$HOME/.bash_history"' \
      'history -s shellspan-bash-history-ready' \
      > /home/shellspan/.bashrc \
    && printf '%s\n' \
      'export SHELLSPAN_ZSH_PROFILE_ORDER="${SHELLSPAN_ZSH_PROFILE_ORDER-}:zshenv"' \
      'export SHELLSPAN_ZSHENV_COUNT=$(( ${SHELLSPAN_ZSHENV_COUNT:-0} + 1 ))' \
      > /home/shellspan-zsh/.zshenv \
    && printf '%s\n' \
      'export SHELLSPAN_ZSH_PROFILE_ORDER="${SHELLSPAN_ZSH_PROFILE_ORDER-}:zprofile"' \
      'export SHELLSPAN_ZPROFILE_COUNT=$(( ${SHELLSPAN_ZPROFILE_COUNT:-0} + 1 ))' \
      'export LANG=C.UTF-8' \
      'printf "shellspan-zsh-login-marker\\n"' \
      > /home/shellspan-zsh/.zprofile \
    && printf '%s\n' \
      'export SHELLSPAN_ZSH_PROFILE_ORDER="${SHELLSPAN_ZSH_PROFILE_ORDER-}:zshrc"' \
      'export SHELLSPAN_ZSHRC_COUNT=$(( ${SHELLSPAN_ZSHRC_COUNT:-0} + 1 ))' \
      'alias shellspan_fixture_alias="printf zsh-alias-ready"' \
      'shellspan_fixture_function() { printf zsh-function-ready; }' \
      'HISTFILE="$HOME/.zsh_history"' \
      'print -s shellspan-zsh-history-ready' \
      > /home/shellspan-zsh/.zshrc \
    && printf '%s\n' \
      'export SHELLSPAN_ZSH_PROFILE_ORDER="${SHELLSPAN_ZSH_PROFILE_ORDER-}:zlogin"' \
      'export SHELLSPAN_ZLOGIN_COUNT=$(( ${SHELLSPAN_ZLOGIN_COUNT:-0} + 1 ))' \
      > /home/shellspan-zsh/.zlogin \
    && chown shellspan:shellspan /home/shellspan/.bash_profile /home/shellspan/.bashrc \
    && chown shellspan-zsh:shellspan-zsh /home/shellspan-zsh/.zshenv /home/shellspan-zsh/.zprofile /home/shellspan-zsh/.zshrc /home/shellspan-zsh/.zlogin

COPY sshd_config /etc/ssh/sshd_config
COPY sshd_no_sftp_config /etc/ssh/sshd_no_sftp_config
COPY shellspan-m6-service /usr/local/bin/shellspan-m6-service

RUN chmod 0755 /usr/local/bin/shellspan-m6-service

EXPOSE 22

CMD ["sh", "-c", "ssh-keygen -A || exit $?; (while true; do printf 'shellspan-forward-ok\\n' | nc -l -p 18080; done) & python3 -m http.server 18081 --bind 127.0.0.1 --directory /tmp >/dev/null 2>&1 & exec /usr/sbin/sshd -D -e"]
