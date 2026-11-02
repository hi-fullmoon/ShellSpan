"""Own a fixture password in the OS keychain and pass it over an ephemeral pipe."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import keyring

fixture_path = Path(sys.argv[1]).resolve()
fixture = json.loads(fixture_path.read_text())
root = Path(fixture['root'])
container = fixture['container']
assert container == 'shellspan-nip-p3-' + fixture['id']
assert subprocess.check_output(['docker', 'inspect', '--format', '{{index .Config.Labels "shellspan.native-input-p3"}}', container], text=True).strip() == fixture['id']
service = 'com.shellspan.native-input-p3.fixture'
reference = fixture['credentialReference']
assert keyring.get_password(service, reference) is None
directory = fixture_path.parent
image = os.environ.get('SHELLSPAN_P3_SSH_TEST_IMAGE')
if image:
    image = Path(image).resolve()
    directory = image.parent
    assert directory.parent == root / '.artifacts/tests/native-input-p3/scoped-ssh-runs'
    assert image.name == 'actual-scoped-ssh-tests' and image.is_file()
result = {'ok': False, 'testOk': False, 'credentialReference': reference}
original_error = None
cleanup_errors = []
try:
    password = secrets.token_urlsafe(36)
    keyring.set_password(service, reference, password)
    password = None
    password = keyring.get_password(service, reference)
    assert password
    subprocess.run(['docker', 'exec', '-i', container, 'chpasswd'], input=f'nativeZle:{password}\n', text=True, check=True, stdout=subprocess.DEVNULL)
    environment = {**os.environ, 'SHELLSPAN_P3_SSH_FIXTURE': str(fixture_path),
                   'CARGO_TARGET_DIR': str(Path(__file__).resolve().parents[2] / 'src-tauri/target')}
    before = set((root / '.artifacts/tests/native-input-p3/production-ssh-zle').glob('*/result.json'))
    with (directory / 'production-test.log').open('xb') as log:
        command = ([str(image), 'session::remote_native::tests::production_remote_zle_parent_parser_and_background', '--ignored', '--exact'] if image else
            ['cargo', 'test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
             'session::remote_native::tests::production_remote_zle_parent_parser_and_background', '--', '--ignored', '--exact'])
        completed = subprocess.run(command,
            cwd=root, env=environment, input=(password + '\n').encode(), stdout=log, stderr=log, check=False)
    password = None
    result['exitCode'] = completed.returncode
    created = set((root / '.artifacts/tests/native-input-p3/production-ssh-zle').glob('*/result.json')) - before
    assert len(created) == 1, 'The exact Rust test did not produce one new actual SSH result'
    observed = json.loads(next(iter(created)).read_text())
    expected_planned = int(os.environ.get('SHELLSPAN_P3_SSH_PLANNED_OPERATIONS', '10'))
    assert expected_planned in (9, 10)
    assert observed['ok'] and observed['actualProductionPreparation'] and observed['plannedOperations'] == expected_planned and observed['completedOperations'] == expected_planned - 1 and observed['finalStopExit143AndGroupEsrch'] and observed['remoteEofOwnedPrefixAndOrdinaryRecovery']
    assert '1 passed; 0 failed; 0 ignored;' in (directory / 'production-test.log').read_text()
    result['actualTestResult'] = str(next(iter(created)).relative_to(root))
    result['testOk'] = completed.returncode == 0
except BaseException as error:
    original_error = error
    result['failureType'] = type(error).__name__
finally:
    password = None
    try:
        locked = subprocess.run(['docker', 'exec', container, 'usermod', '-L', 'nativeZle'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        result['accountLocked'] = locked.returncode == 0
        if locked.returncode != 0:
            cleanup_errors.append('owned-account-lock-failed')
    except BaseException:
        result['accountLocked'] = False
        cleanup_errors.append('owned-account-lock-unavailable')
    finally:
        try:
            keyring.delete_password(service, reference)
        except keyring.errors.PasswordDeleteError:
            pass
        except BaseException:
            cleanup_errors.append('os-keychain-delete-failed')
        try:
            result['credentialDeleted'] = keyring.get_password(service, reference) is None
            if not result['credentialDeleted']:
                cleanup_errors.append('os-keychain-credential-remains')
        except BaseException:
            result['credentialDeleted'] = False
            cleanup_errors.append('os-keychain-absence-check-failed')
    result['cleanupErrors'] = cleanup_errors
    result['ok'] = result['testOk'] and not cleanup_errors
    (directory / 'run-result.json').write_text(json.dumps(result, indent=2))
if original_error is not None:
    raise original_error
assert not cleanup_errors, 'Owned cleanup failed; actual test outcome retained separately'
assert result['ok'], 'Actual production SSH test failed; original evidence retained'
