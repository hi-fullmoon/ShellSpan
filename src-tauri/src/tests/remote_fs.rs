    use super::*;

    struct ShortReader<R> {
        inner: R,
        max_read: usize,
    }

    impl<R: Read> Read for ShortReader<R> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let limit = buffer.len().min(self.max_read);
            self.inner.read(&mut buffer[..limit])
        }
    }

    #[derive(Default)]
    struct ShortWriter {
        bytes: Vec<u8>,
        max_write: usize,
        write_calls: usize,
    }

    impl Write for ShortWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.write_calls += 1;
            let count = buffer.len().min(self.max_write);
            self.bytes.extend_from_slice(&buffer[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    struct NoopTransferEventEmitter;

    impl TransferEventEmitter for NoopTransferEventEmitter {
        fn emit_transfer_event<S>(&self, _event: &str, _payload: S) -> Result<(), String>
        where
            S: serde::Serialize + Clone,
        {
            Ok(())
        }
    }

    #[test]
    fn transfer_buffer_size_accepts_inclusive_boundaries_and_rejects_out_of_range() {
        assert_eq!(
            validate_transfer_buffer_size(MIN_TRANSFER_BUFFER_SIZE),
            Ok(MIN_TRANSFER_BUFFER_SIZE)
        );
        assert_eq!(
            validate_transfer_buffer_size(MAX_TRANSFER_BUFFER_SIZE),
            Ok(MAX_TRANSFER_BUFFER_SIZE)
        );
        assert!(validate_transfer_buffer_size(MIN_TRANSFER_BUFFER_SIZE - 1).is_err());
        assert!(validate_transfer_buffer_size(MAX_TRANSFER_BUFFER_SIZE + 1).is_err());
    }

    #[test]
    fn transfer_chunk_copies_full_reads_and_reports_exact_progress_bytes() {
        let source = b"0123456789abcdef";
        let mut reader = io::Cursor::new(source);
        let mut writer = io::Cursor::new(Vec::new());
        let mut buffer = vec![0; 8];
        let buffer_address = buffer.as_ptr();
        let mut progressed = 0u64;

        loop {
            let read = transfer_chunk(&mut reader, &mut writer, &mut buffer)
                .expect("full chunk transfer should succeed");
            if read == 0 {
                break;
            }
            progressed += read as u64;
        }

        assert_eq!(writer.into_inner(), source);
        assert_eq!(progressed, source.len() as u64);
        assert_eq!(buffer.as_ptr(), buffer_address, "buffer must be reused");
    }

    #[test]
    fn transfer_chunk_handles_short_reads_and_short_writes_without_losing_bytes() {
        let source = b"short reads and writes cross chunk boundaries";
        let mut reader = ShortReader {
            inner: io::Cursor::new(source),
            max_read: 3,
        };
        let mut writer = ShortWriter {
            max_write: 2,
            ..ShortWriter::default()
        };
        let mut buffer = vec![0; 11];
        let mut progressed = 0u64;

        loop {
            let read = transfer_chunk(&mut reader, &mut writer, &mut buffer)
                .expect("short chunk transfer should succeed");
            if read == 0 {
                break;
            }
            progressed += read as u64;
        }

        assert_eq!(writer.bytes, source);
        assert_eq!(progressed, source.len() as u64);
        assert!(writer.write_calls > source.len().div_ceil(3));
    }

    #[test]
    fn remote_copy_progress_does_not_double_count_retried_or_resumed_prefixes() {
        let mut credited = 0u64;
        let mut progressed = 0u64;

        // First attempt resumes at 40 and reaches 70. The retry observes a
        // shorter 55-byte temp file, re-sends the already-credited prefix, then
        // advances beyond it. Only unique completed offsets count as progress.
        for completed_offset in [40, 70, 55, 65, 70, 85, 100] {
            let delta = uncredited_remote_copy_bytes(credited, completed_offset);
            progressed += delta;
            if delta > 0 {
                credited = completed_offset;
            }
        }

        assert_eq!(credited, 100);
        assert_eq!(progressed, 100);
    }

    #[test]
    fn transfer_metric_record_contains_every_batch_field_without_connection_secrets() {
        let mut metrics = TransferBatchMetrics::new("upload", "metric-test-operation".to_string());
        metrics.connect = Duration::from_micros(11);
        metrics.scan = Duration::from_micros(22);
        metrics.transfer = Duration::from_micros(33);
        metrics.finalize = Duration::from_micros(44);
        metrics.set_inventory(1_024, 7);

        let record = metrics.record("completed");
        metrics.logged = true;

        for field in [
            "operation=upload",
            "operation_id=\"metric-test-operation\"",
            "status=completed",
            "connect_us=11",
            "scan_us=22",
            "transfer_us=33",
            "finalize_us=44",
            "total_us=",
            "total_bytes=1024",
            "file_count=7",
            "throughput_bytes_per_second=",
        ] {
            assert!(record.contains(field), "missing {field} in {record}");
        }
        for secret_field in ["password", "passphrase", "private_key_data"] {
            assert!(!record.contains(secret_field));
        }
    }

    #[test]
    fn transfer_throughput_uses_end_to_end_elapsed_time() {
        assert_eq!(
            throughput_bytes_per_second(8 * 1024 * 1024, Duration::from_secs(2)),
            4 * 1024 * 1024
        );
        assert_eq!(throughput_bytes_per_second(0, Duration::from_secs(2)), 0);
        assert_eq!(throughput_bytes_per_second(100, Duration::ZERO), 0);
    }

    fn empty_file_stat() -> FileStat {
        FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: None,
        }
    }

    #[test]
    fn superseded_directory_reader_does_not_request_another_entry() {
        let superseded = AtomicBool::new(false);
        let reads = std::cell::Cell::new(0);

        let result = collect_remote_directory_entries(Path::new("/remote"), &superseded, || {
            let next_read = reads.get() + 1;
            reads.set(next_read);
            assert_eq!(next_read, 1, "superseded listing read another entry");
            // Simulate a newer pane generation arriving while this one
            // File::readdir call was blocked in libssh2.
            superseded.store(true, AtomicOrdering::SeqCst);
            Ok(RemoteDirectoryRead::Entry(
                PathBuf::from("old.txt"),
                empty_file_stat(),
            ))
        });

        assert!(matches!(
            result,
            Err(RemoteFsError::Other { ref message })
                if message == crate::directory_request_registry::DIRECTORY_REQUEST_SUPERSEDED_MESSAGE
        ));
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn directory_reader_retries_and_preserves_filter_and_join_semantics() {
        let superseded = AtomicBool::new(false);
        let mut reads = std::collections::VecDeque::from([
            RemoteDirectoryRead::Retry,
            RemoteDirectoryRead::Entry(PathBuf::from("."), empty_file_stat()),
            RemoteDirectoryRead::Entry(PathBuf::from(".."), empty_file_stat()),
            RemoteDirectoryRead::Entry(PathBuf::from("report.txt"), empty_file_stat()),
            RemoteDirectoryRead::End,
        ]);

        let entries = collect_remote_directory_entries(Path::new("/remote"), &superseded, || {
            Ok(reads.pop_front().expect("reader should stop at EOF"))
        })
        .expect("current directory request should finish");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, PathBuf::from("/remote/report.txt"));
        assert!(reads.is_empty());
    }

    #[test]
    fn remote_file_reads_use_dedicated_connections() {
        assert_eq!(
            OPEN_REMOTE_FILE_CONNECTION_MODE,
            RemoteFileReadConnectionMode::Dedicated
        );
        assert_eq!(
            PREVIEW_REMOTE_FILE_CONNECTION_MODE,
            RemoteFileReadConnectionMode::Dedicated
        );
    }

    #[test]
    fn cancelled_remote_file_read_stops_after_the_in_flight_chunk() {
        struct CancelAfterFirstRead<'a> {
            cancel_flag: &'a AtomicBool,
            calls: usize,
        }

        impl Read for CancelAfterFirstRead<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.calls += 1;
                assert_eq!(self.calls, 1, "cancelled reader performed another read");
                buffer[..4].copy_from_slice(b"data");
                self.cancel_flag.store(true, AtomicOrdering::SeqCst);
                Ok(4)
            }
        }

        let cancel_flag = AtomicBool::new(false);
        let mut reader = CancelAfterFirstRead {
            cancel_flag: &cancel_flag,
            calls: 0,
        };
        let mut output = Vec::new();

        let error =
            copy_remote_file_read_with_cancellation(&mut reader, &mut output, None, &cancel_flag)
                .expect_err("cancellation after a remote read must stop the copy");

        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(error.to_string(), REMOTE_FILE_READ_CANCELLED_MESSAGE);
        assert_eq!(reader.calls, 1);
        assert!(
            output.is_empty(),
            "cancelled bytes must not be committed locally"
        );
    }

    #[test]
    fn preview_reader_never_reads_past_its_bounded_limit() {
        let cancel_flag = AtomicBool::new(false);
        let mut reader = std::io::Cursor::new(b"0123456789".to_vec());
        let mut output = Vec::new();

        let copied = copy_remote_file_read_with_cancellation(
            &mut reader,
            &mut output,
            Some(5),
            &cancel_flag,
        )
        .expect("bounded preview read should succeed");

        assert_eq!(copied, 5);
        assert_eq!(output, b"01234");
        assert_eq!(reader.position(), 5);
    }

    #[test]
    fn open_temp_file_guard_removes_failed_download() {
        let directory = tempfile::tempdir().expect("create open temp directory");
        let path = directory.path().join("partial.txt");
        fs::write(&path, b"partial contents").expect("write partial open temp file");

        {
            let _guard = OpenTempFileGuard::new(path.clone());
        }

        assert!(!path.exists());
    }

    #[test]
    fn open_temp_file_name_is_bounded_and_preserves_a_safe_extension() {
        let name = open_temp_file_name(&format!("{}.txt", "x".repeat(255)));
        assert!(name.len() < 80);
        assert!(name.ends_with(".txt"));

        let unsafe_extension = open_temp_file_name("report.secret/extension");
        assert!(unsafe_extension.len() < 80);
    }

    #[test]
    fn private_open_temp_creation_never_overwrites_a_collision() {
        let directory = tempfile::tempdir().expect("create open temp directory");
        let path = directory.path().join("collision.txt");
        fs::write(&path, b"existing").unwrap();

        assert!(create_private_open_temp_file(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing");
    }

    #[cfg(unix)]
    #[test]
    fn remote_open_cache_and_files_are_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("create parent temp directory");
        let open_root = directory.path().join("open-cache");
        prepare_private_open_root(&open_root).unwrap();
        let file_path = open_root.join("private.txt");
        drop(create_private_open_temp_file(&file_path).unwrap());

        assert_eq!(
            fs::metadata(&open_root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&file_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn oversized_open_copy_is_bounded_and_removes_its_partial_temp_file() {
        let directory = tempfile::tempdir().expect("create open temp directory");
        let path = directory.path().join("oversized.txt");
        let cancel_flag = AtomicBool::new(false);
        let mut reader = std::io::Cursor::new(b"0123456789".to_vec());

        let error = {
            let _guard = OpenTempFileGuard::new(path.clone());
            let mut local_file = fs::File::create(&path).expect("create partial open temp file");
            copy_remote_file_for_open_with_limit(&mut reader, &mut local_file, 5, &cancel_flag)
                .expect_err("a growing remote file must not exceed the open limit")
        };

        assert!(matches!(
            error,
            RemoteFsError::Other { ref message } if message.contains("more than 5 bytes")
        ));
        assert_eq!(reader.position(), 6, "the reader went past limit + 1");
        assert!(
            !path.exists(),
            "the rejected partial temp file was retained"
        );
    }

    #[test]
    fn open_temp_file_guard_preserves_successful_download() {
        let directory = tempfile::tempdir().expect("create open temp directory");
        let path = directory.path().join("complete.txt");
        fs::write(&path, b"complete contents").expect("write complete open temp file");

        OpenTempFileGuard::new(path.clone()).preserve();

        assert_eq!(
            fs::read(&path).expect("read retained open temp file"),
            b"complete contents"
        );
    }

    #[test]
    fn preview_text_decoder_accepts_utf8_and_utf16_bom() {
        assert_eq!(
            decode_preview_text(b"hello\nworld", false),
            Some("hello\nworld".to_string())
        );
        assert_eq!(
            decode_preview_text(&[0xff, 0xfe, b'h', 0, b'i', 0], false),
            Some("hi".to_string()),
        );
        assert_eq!(
            decode_preview_text(&[0xfe, 0xff, 0, b'h', 0, b'i'], false),
            Some("hi".to_string()),
        );
    }

    #[test]
    fn preview_text_decoder_rejects_binary_controls_and_invalid_utf8() {
        assert_eq!(decode_preview_text(&[0, 1, 2, 3], false), None);
        assert_eq!(decode_preview_text(&[0xff, 0x00, 0x80], false), None);
    }

    #[test]
    fn preview_text_decoder_only_accepts_incomplete_utf8_for_truncated_prefixes() {
        let partial = [b'h', b'i', 0xe4, 0xbd];
        assert_eq!(decode_preview_text(&partial, false), None);
        assert_eq!(decode_preview_text(&partial, true), Some("hi".to_string()));

        let partial_utf16 = [0xff, 0xfe, b'h', 0, 0x3d, 0xd8];
        assert_eq!(decode_preview_text(&partial_utf16, false), None);
        assert_eq!(
            decode_preview_text(&partial_utf16, true),
            Some("h".to_string())
        );
    }

    #[test]
    fn preview_binary_hint_keeps_ascii_pdf_and_media_as_bytes() {
        assert!(preview_extension_requires_binary("manual.PDF"));
        assert!(preview_extension_requires_binary("sound.mp3"));
        assert!(preview_extension_requires_binary("diagram.svg"));
        assert!(!preview_extension_requires_binary("settings.toml"));
        assert!(preview_extension_requires_complete_file("diagram.svg"));
        assert!(preview_extension_requires_complete_file("manual.pdf"));
        assert!(!preview_extension_requires_complete_file("server.log"));
        assert!(preview_extension_requires_complete_file("backup.zip"));
        assert!(preview_extension_requires_complete_file("legacy.doc"));
        assert!(preview_extension_requires_complete_file("report.docx"));
    }

    #[test]
    fn legacy_doc_preview_rejects_incomplete_or_invalid_compound_files() {
        assert_eq!(
            decode_file_preview_text("legacy.doc", b"not a compound file", false),
            None
        );
        assert_eq!(
            decode_file_preview_text("legacy.doc", b"partial", true),
            None
        );
    }

    #[test]
    fn parse_identity_lookup_output_splits_users_and_groups() {
        let output = "u\t1000\talice\ng\t100\twheel\nu\t0\troot\ngarbage line\nu\tnotanumber\tbob\nu\t1001\t\n";

        let (owners, groups) = parse_identity_lookup_output(output);

        assert_eq!(owners.get(&1000), Some(&"alice".to_string()));
        assert_eq!(owners.get(&0), Some(&"root".to_string()));
        assert_eq!(groups.get(&100), Some(&"wheel".to_string()));
        assert_eq!(owners.len(), 2);
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn build_identity_lookup_command_uses_single_shell_for_both_kinds() {
        let command = build_remote_identity_lookup_command(&[0, 1000], &[100]);

        assert!(command.starts_with("sh -lc '"));
        assert!(command.ends_with('\''));
        assert!(command.contains("lookup_ids passwd pwd getpwuid pw_name u 0 1000;"));
        assert!(command.contains("lookup_ids group grp getgrgid gr_name g 100;"));
        // Single quotes inside the script would break the outer sh -lc quoting.
        let script = &command["sh -lc '".len()..command.len() - 1];
        assert!(
            !script.contains('\''),
            "script must not contain single quotes: {script}"
        );
    }

    #[test]
    fn build_identity_lookup_command_skips_empty_kind() {
        let command = build_remote_identity_lookup_command(&[], &[100]);

        assert!(!command.contains("passwd"));
        assert!(command.contains("lookup_ids group grp getgrgid gr_name g 100;"));
    }

    #[test]
    fn superseded_owner_exec_stops_before_the_next_network_read() {
        let superseded = AtomicBool::new(false);
        let mut stdout_reads = 0;
        let mut stderr_reads = 0;
        let mut waits = 0;

        let result = collect_remote_exec_output(
            &superseded,
            Some(Duration::from_secs(1)),
            || {
                stdout_reads += 1;
                assert_eq!(stdout_reads, 1, "superseded lookup read stdout again");
                superseded.store(true, AtomicOrdering::SeqCst);
                Ok(RemoteExecReadStep::Data(b"u\t1000\talice\n".to_vec()))
            },
            || {
                stderr_reads += 1;
                Ok(RemoteExecReadStep::End)
            },
            || {
                waits += 1;
                Ok(())
            },
        );

        assert_eq!(
            result,
            Err(RemoteFsError::Other {
                message: crate::directory_request_registry::DIRECTORY_REQUEST_SUPERSEDED_MESSAGE
                    .to_string(),
            })
        );
        assert_eq!(stdout_reads, 1);
        assert_eq!(stderr_reads, 0);
        assert_eq!(waits, 0);
    }

    #[test]
    fn same_connection_copy_rejects_copying_entry_onto_itself() {
        let result = validate_same_connection_copy_destination(
            Path::new("/srv/report.txt"),
            Path::new("/srv/report.txt"),
            false,
        );

        assert_eq!(
            result,
            Err(RemoteFsError::Other {
                message: "cannot copy a remote entry onto itself".to_string()
            })
        );
    }

    #[test]
    fn same_connection_copy_rejects_directory_descendant() {
        let result = validate_same_connection_copy_destination(
            Path::new("/srv/assets"),
            Path::new("/srv/assets/archive/assets"),
            true,
        );

        assert_eq!(
            result,
            Err(RemoteFsError::Other {
                message: "cannot copy a directory into itself".to_string()
            })
        );
    }

    #[test]
    fn same_connection_copy_allows_sibling_destination() {
        assert!(validate_same_connection_copy_destination(
            Path::new("/srv/assets"),
            Path::new("/backup/assets"),
            true,
        )
        .is_ok());
    }

    #[test]
    fn remote_copy_staging_path_is_hidden_unique_and_next_to_destination() {
        let first = remote_copy_staging_path(Path::new("/srv/report.txt"));
        let second = remote_copy_staging_path(Path::new("/srv/report.txt"));

        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(Path::new("/srv")));
        assert!(first
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(".shellspan-copy-")));
        assert!(first.file_name().unwrap().len() < 80);
    }

    #[test]
    fn remote_hidden_paths_do_not_inherit_a_name_max_length_destination() {
        let destination = Path::new("/srv").join("x".repeat(255));

        for path in [
            remote_copy_staging_path(&destination),
            remote_copy_backup_path(&destination),
            upload_temp_path(&destination),
            upload_backup_path(&destination),
        ] {
            assert_eq!(path.parent(), Some(Path::new("/srv")));
            assert!(path.file_name().unwrap().len() < 80);
        }
    }

    #[test]
    fn remote_copy_rename_flags_only_enable_overwrite_when_requested() {
        let fail_safe_flags = remote_copy_rename_flags(false);
        assert!(fail_safe_flags.contains(RenameFlags::ATOMIC));
        assert!(fail_safe_flags.contains(RenameFlags::NATIVE));
        assert!(!fail_safe_flags.contains(RenameFlags::OVERWRITE));

        let overwrite_flags = remote_copy_rename_flags(true);
        assert!(overwrite_flags.contains(RenameFlags::ATOMIC));
        assert!(overwrite_flags.contains(RenameFlags::NATIVE));
        assert!(overwrite_flags.contains(RenameFlags::OVERWRITE));
    }

    #[test]
    fn remote_copy_replace_preserves_file_over_directory_semantics() {
        assert_eq!(
            remote_copy_destination_action(UploadConflictPolicy::Replace, RemoteFileKind::File,),
            RemoteCopyDestinationAction::Copy {
                allow_overwrite: true,
                replace_any: true,
                remove_destination_before_copy: false,
            }
        );
        assert_eq!(
            remote_copy_destination_action(UploadConflictPolicy::Overwrite, RemoteFileKind::File,),
            RemoteCopyDestinationAction::Copy {
                allow_overwrite: true,
                replace_any: false,
                remove_destination_before_copy: false,
            }
        );
        assert_eq!(
            remote_copy_destination_action(
                UploadConflictPolicy::Replace,
                RemoteFileKind::Directory,
            ),
            RemoteCopyDestinationAction::Copy {
                allow_overwrite: false,
                replace_any: false,
                remove_destination_before_copy: true,
            }
        );
    }

    #[test]
    fn upload_temp_path_is_hidden_unique_and_next_to_destination() {
        let first = upload_temp_path(Path::new("/srv/report.txt"));
        let second = upload_temp_path(Path::new("/srv/report.txt"));

        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(Path::new("/srv")));
        assert!(first
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(".shellspan-upload-")));
    }

    #[test]
    fn upload_backup_path_is_hidden_unique_and_next_to_destination() {
        let first = upload_backup_path(Path::new("/srv/report.txt"));
        let second = upload_backup_path(Path::new("/srv/report.txt"));

        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(Path::new("/srv")));
        assert!(first
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(".shellspan-upload-backup-")));
    }

    #[test]
    fn only_sftp_no_such_file_is_treated_as_a_missing_remote_path() {
        let missing = ssh2::Error::from_errno(ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE));
        let permission_denied = ssh2::Error::from_errno(ErrorCode::SFTP(3));
        let transport = ssh2::Error::from_errno(ErrorCode::Session(LIBSSH2_ERROR_FILE));

        assert!(is_remote_path_missing(&missing));
        assert!(!is_remote_path_missing(&permission_denied));
        assert!(!is_remote_path_missing(&transport));
    }

    #[test]
    fn remote_copy_resume_starts_fresh_without_usable_temp_file() {
        assert_eq!(remote_copy_resume(None, 100), RemoteCopyResume::Fresh);
        assert_eq!(remote_copy_resume(Some(0), 100), RemoteCopyResume::Fresh);
        assert_eq!(remote_copy_resume(None, 0), RemoteCopyResume::Fresh);
    }

    #[test]
    fn remote_copy_resume_continues_from_partial_temp_file() {
        assert_eq!(
            remote_copy_resume(Some(40), 100),
            RemoteCopyResume::Resume(40)
        );
    }

    #[test]
    fn remote_copy_resume_skips_transfer_when_temp_file_is_complete() {
        assert_eq!(
            remote_copy_resume(Some(100), 100),
            RemoteCopyResume::AlreadyComplete
        );
    }

    #[test]
    fn remote_copy_resume_restarts_when_temp_file_exceeds_source() {
        assert_eq!(
            remote_copy_resume(Some(140), 100),
            RemoteCopyResume::Restart
        );
    }

    #[test]
    fn upload_target_name_overwrites_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_upload_target_name(
            &existing_names,
            "report.txt",
            UploadConflictPolicy::Overwrite,
        )
        .expect("overwrite policy should allow replacing the existing target");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn upload_target_name_replaces_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("assets")]);

        let resolved =
            resolve_upload_target_name(&existing_names, "assets", UploadConflictPolicy::Replace)
                .expect("replace policy should allow replacing the existing target");

        assert_eq!(resolved, Some(String::from("assets")));
    }

    #[test]
    fn upload_target_name_skips_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let resolved =
            resolve_upload_target_name(&existing_names, "report.txt", UploadConflictPolicy::Skip)
                .expect("skip policy should be treated as a valid decision");

        assert_eq!(resolved, None);
    }

    #[test]
    fn upload_target_name_rejects_existing_entry_without_explicit_resolution() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let error =
            resolve_upload_target_name(&existing_names, "report.txt", UploadConflictPolicy::Fail)
                .expect_err("missing overwrite confirmation should fail the upload");

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("report.txt")),
            "expected error to mention the conflicting file name, got {error:?}"
        );
    }

    #[test]
    fn upload_target_name_allows_new_entry_without_conflict() {
        let existing_names = HashSet::<String>::new();

        let resolved =
            resolve_upload_target_name(&existing_names, "report.txt", UploadConflictPolicy::Fail)
                .expect("new names should upload without additional confirmation");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn shellspan_directory_name_is_not_reserved() {
        // `.shellspan` used to be reserved for application data; it is an
        // ordinary name now that nothing is staged on the server.
        assert!(validate_remote_name(".shellspan").is_ok());
        assert!(validate_remote_name("reports").is_ok());
    }

    #[test]
    fn download_name_overwrites_existing_entry_when_requested() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Overwrite),
        )
        .expect("overwrite policy should allow replacing the existing target");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn download_name_skips_existing_entry_when_requested() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Skip),
        )
        .expect("skip policy should be treated as a valid decision");

        assert_eq!(resolved, None);
    }

    #[test]
    fn download_name_rejects_existing_entry_without_explicit_resolution() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let error = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Fail),
        )
        .expect_err("fail policy should reject the conflicting download target");

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("report.txt")),
            "expected error to mention the conflicting file name, got {error:?}"
        );
    }

    #[test]
    fn download_name_renames_to_unique_without_policy() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_local_download_name(&reserved_names, "report.txt", None)
            .expect("downloads without a policy should keep the rename-to-unique behavior");

        assert_eq!(resolved, Some(String::from("report copy.txt")));
    }

    #[test]
    fn download_name_allows_new_entry_without_conflict() {
        let reserved_names = HashSet::<String>::new();

        let resolved = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Fail),
        )
        .expect("new names should download without additional confirmation");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn detects_transport_disconnected_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "SSH transport disconnected".to_string()
        }));
    }

    #[test]
    fn detects_transport_read_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "transport read error".to_string()
        }));
    }

    #[test]
    fn detects_connection_reset_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "connection reset by peer".to_string()
        }));
    }

    #[test]
    fn detects_broken_pipe_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "broken pipe".to_string()
        }));
    }

    #[test]
    fn ignores_unrelated_errors() {
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "file not found".to_string()
        }));
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "permission denied".to_string()
        }));
    }

    #[test]
    fn detects_specific_socket_phrases_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket error".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "failed reading from socket".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket closed".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket disconnect".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket disconnected".to_string()
        }));
    }

    #[test]
    fn detects_libssh2_transport_messages_as_connection_errors() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[Session(-7)] socket send failure".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[Session(-43)] error receiving on socket".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[SFTP(7)] no connection".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[SFTP(8)] connection lost".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[Session(-9)] timed out".to_string()
        }));
    }

    #[test]
    fn detects_connection_error_inside_transfer_batch() {
        let batch = TransferBatchResult {
            items: vec![
                TransferItemResult {
                    source_path: "/remote/a.txt".to_string(),
                    destination_path: Some("/local/a.txt".to_string()),
                    status: TransferItemStatus::Completed,
                    error: None,
                },
                TransferItemResult {
                    source_path: "/remote/b.txt".to_string(),
                    destination_path: None,
                    status: TransferItemStatus::Failed,
                    error: Some("[Session(-7)] socket send failure".to_string()),
                },
            ],
        };

        assert!(transfer_batch_has_connection_error(&batch));
    }

    #[test]
    fn does_not_treat_generic_socket_substring_as_connection_error() {
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "invalid socket path".to_string()
        }));
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "socket".to_string()
        }));
    }

    #[test]
    fn cmp_ascii_case_insensitive_orders_case_insensitively() {
        assert_eq!(cmp_ascii_case_insensitive("abc", "abc"), Ordering::Equal);
        assert_eq!(cmp_ascii_case_insensitive("ABC", "abc"), Ordering::Equal);
        assert_eq!(cmp_ascii_case_insensitive("abc", "abd"), Ordering::Less);
        assert_eq!(cmp_ascii_case_insensitive("abd", "abc"), Ordering::Greater);
        assert_eq!(cmp_ascii_case_insensitive("abc", "abcd"), Ordering::Less);
        assert_eq!(cmp_ascii_case_insensitive("abcd", "abc"), Ordering::Greater);
        assert_eq!(cmp_ascii_case_insensitive("", ""), Ordering::Equal);
        assert_eq!(cmp_ascii_case_insensitive("a", ""), Ordering::Greater);
    }

    #[test]
    fn sort_remote_entries_directories_first_then_case_insensitive() {
        let dir = RemoteFileEntry {
            path: "/d".to_string(),
            name: "Zeta".to_string(),
            kind: RemoteFileKind::Directory,
            size: None,
            modified_at: None,
            permissions: None,
            owner_uid: None,
            group_gid: None,
            owner_name: None,
            group_name: None,
        };
        let file = RemoteFileEntry {
            kind: RemoteFileKind::File,
            name: "alpha".to_string(),
            ..dir.clone()
        };
        assert_eq!(sort_remote_entries(&dir, &file), Ordering::Less);
        assert_eq!(sort_remote_entries(&file, &dir), Ordering::Greater);
        assert_eq!(sort_remote_entries(&file, &file), Ordering::Equal);
    }

    #[test]
    fn unique_local_download_name_keeps_free_base_name() {
        let reserved = HashSet::from([String::from("other.txt")]);

        let resolved = unique_local_download_name(&reserved, "report.txt")
            .expect("free name should be usable as-is");

        assert_eq!(resolved, "report.txt");
    }

    #[test]
    fn unique_local_download_name_suffixes_conflicting_names() {
        let reserved = HashSet::from([String::from("report.txt"), String::from("report copy.txt")]);

        let resolved = unique_local_download_name(&reserved, "report.txt")
            .expect("a unique variant should be found");

        assert_eq!(resolved, "report copy 2.txt");
    }

    #[test]
    fn unique_local_download_name_handles_dotfiles_without_extension_split() {
        let reserved = HashSet::from([String::from(".gitignore")]);

        let resolved = unique_local_download_name(&reserved, ".gitignore")
            .expect("a unique variant should be found");

        assert_eq!(resolved, ".gitignore copy");
    }

    #[test]
    fn recursion_depth_within_limit_is_accepted() {
        assert!(ensure_remote_recursion_depth(0).is_ok());
        assert!(ensure_remote_recursion_depth(MAX_REMOTE_RECURSION_DEPTH).is_ok());
    }

    #[test]
    fn recursion_depth_beyond_limit_is_rejected() {
        let error = ensure_remote_recursion_depth(MAX_REMOTE_RECURSION_DEPTH + 1)
            .expect_err("nesting past the limit should fail");

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("depth")),
            "expected error to mention the depth limit, got {error:?}"
        );
    }

    #[derive(Default)]
    struct FakeRemoteTreeReader {
        stats: HashMap<PathBuf, FileStat>,
        children: HashMap<PathBuf, Vec<PathBuf>>,
        lstat_calls: std::cell::RefCell<HashMap<PathBuf, usize>>,
        readdir_calls: std::cell::RefCell<HashMap<PathBuf, usize>>,
        cancel_after_lstat: Option<Arc<AtomicBool>>,
    }

    impl FakeRemoteTreeReader {
        fn stat_calls(&self, path: &str) -> usize {
            self.lstat_calls
                .borrow()
                .get(Path::new(path))
                .copied()
                .unwrap_or(0)
        }

        fn directory_calls(&self, path: &str) -> usize {
            self.readdir_calls
                .borrow()
                .get(Path::new(path))
                .copied()
                .unwrap_or(0)
        }
    }

    impl RemoteTreeReader for FakeRemoteTreeReader {
        fn lstat(&self, path: &Path) -> Result<FileStat, String> {
            *self
                .lstat_calls
                .borrow_mut()
                .entry(path.to_path_buf())
                .or_default() += 1;
            if let Some(cancel_flag) = self.cancel_after_lstat.as_ref() {
                cancel_flag.store(true, AtomicOrdering::SeqCst);
            }
            self.stats
                .get(path)
                .map(copy_file_stat)
                .ok_or_else(|| format!("missing fake stat for {}", path.display()))
        }

        fn readdir(&self, path: &Path) -> Result<Vec<PathBuf>, String> {
            *self
                .readdir_calls
                .borrow_mut()
                .entry(path.to_path_buf())
                .or_default() += 1;
            self.children
                .get(path)
                .cloned()
                .ok_or_else(|| format!("missing fake directory for {}", path.display()))
        }
    }

    fn copy_file_stat(stat: &FileStat) -> FileStat {
        FileStat {
            size: stat.size,
            uid: stat.uid,
            gid: stat.gid,
            perm: stat.perm,
            atime: stat.atime,
            mtime: stat.mtime,
        }
    }

    fn fake_file_stat(perm: u32, size: u64) -> FileStat {
        FileStat {
            size: Some(size),
            uid: Some(1000),
            gid: Some(1000),
            perm: Some(perm),
            atime: Some(10),
            mtime: Some(20),
        }
    }

    #[test]
    fn remote_transfer_manifest_inspects_each_entry_and_scans_each_directory_once() {
        let root = PathBuf::from("/source");
        let nested = PathBuf::from("/source/nested");
        let empty = PathBuf::from("/source/empty");
        let file = PathBuf::from("/source/nested/report.txt");
        let symlink = PathBuf::from("/source/current");
        let reader = FakeRemoteTreeReader {
            stats: HashMap::from([
                (root.clone(), fake_file_stat(0o040755, 0)),
                (nested.clone(), fake_file_stat(0o040750, 0)),
                (empty.clone(), fake_file_stat(0o040700, 0)),
                (file.clone(), fake_file_stat(0o100640, 42)),
                (symlink.clone(), fake_file_stat(0o120777, 8)),
            ]),
            children: HashMap::from([
                (
                    root.clone(),
                    vec![nested.clone(), empty.clone(), symlink.clone()],
                ),
                (nested.clone(), vec![file.clone()]),
                (empty.clone(), Vec::new()),
            ]),
            ..FakeRemoteTreeReader::default()
        };
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let manifest = build_remote_transfer_manifest(
            &reader,
            &root,
            None,
            &cancel_flag,
            0,
            RemoteManifestPurpose::Download,
        )
        .expect("manifest scan should succeed");
        let download_stats = manifest.download_stats();
        let remote_copy_stats = manifest.remote_copy_stats();

        assert_eq!(download_stats.total_steps, 5);
        assert_eq!(download_stats.total_bytes, 42);
        assert_eq!(remote_copy_stats.total_steps, 5);
        assert_eq!(remote_copy_stats.total_bytes, 42);
        assert_eq!(reader.stat_calls("/source"), 1);
        assert_eq!(reader.stat_calls("/source/nested"), 1);
        assert_eq!(reader.stat_calls("/source/empty"), 1);
        assert_eq!(reader.stat_calls("/source/nested/report.txt"), 1);
        assert_eq!(reader.stat_calls("/source/current"), 1);
        assert_eq!(reader.directory_calls("/source"), 1);
        assert_eq!(reader.directory_calls("/source/nested"), 1);
        assert_eq!(reader.directory_calls("/source/empty"), 1);

        // Walking the reusable plan for both progress profiles performs no
        // additional remote metadata reads or directory listings.
        assert_eq!(reader.stat_calls("/source"), 1);
        assert_eq!(reader.directory_calls("/source"), 1);
        assert!(manifest.children.iter().any(|child| {
            child.source_path == empty
                && kind_from_permissions(child.stat.perm) == RemoteFileKind::Directory
                && child.children.is_empty()
        }));
        assert!(manifest.children.iter().any(|child| {
            child.source_path == symlink
                && kind_from_permissions(child.stat.perm) == RemoteFileKind::Symlink
                && child.children.is_empty()
        }));
    }

    #[test]
    fn remote_transfer_manifest_reuses_an_already_inspected_copy_root() {
        let root = PathBuf::from("/source");
        let file = PathBuf::from("/source/report.txt");
        let reader = FakeRemoteTreeReader {
            stats: HashMap::from([
                (root.clone(), fake_file_stat(0o040755, 0)),
                (file.clone(), fake_file_stat(0o100644, 7)),
            ]),
            children: HashMap::from([(root.clone(), vec![file.clone()])]),
            ..FakeRemoteTreeReader::default()
        };
        let root_stat = reader
            .stats
            .get(&root)
            .map(copy_file_stat)
            .expect("root stat should exist");

        let manifest = build_remote_transfer_manifest(
            &reader,
            &root,
            Some(root_stat),
            &Arc::new(AtomicBool::new(false)),
            0,
            RemoteManifestPurpose::RemoteCopy,
        )
        .expect("copy scan should reuse its root validation stat");

        assert_eq!(manifest.remote_copy_stats().total_bytes, 7);
        assert_eq!(reader.stat_calls("/source"), 0);
        assert_eq!(reader.stat_calls("/source/report.txt"), 1);
        assert_eq!(reader.directory_calls("/source"), 1);
    }

    #[test]
    fn remote_transfer_manifest_honours_cancellation_before_metadata_reads() {
        let reader = FakeRemoteTreeReader::default();
        let cancel_flag = Arc::new(AtomicBool::new(true));

        let download_error = build_remote_transfer_manifest(
            &reader,
            Path::new("/source"),
            None,
            &cancel_flag,
            0,
            RemoteManifestPurpose::Download,
        )
        .err()
        .expect("cancelled download scan should fail");
        let copy_error = build_remote_transfer_manifest(
            &reader,
            Path::new("/source"),
            None,
            &cancel_flag,
            0,
            RemoteManifestPurpose::RemoteCopy,
        )
        .err()
        .expect("cancelled copy scan should fail");

        assert!(matches!(
            download_error,
            RemoteFsError::Other { ref message } if message == "download cancelled"
        ));
        assert!(matches!(
            copy_error,
            RemoteFsError::Other { ref message } if message == "remote copy cancelled"
        ));
        assert_eq!(reader.stat_calls("/source"), 0);
        assert_eq!(reader.directory_calls("/source"), 0);
    }

    #[test]
    fn remote_transfer_manifest_stops_before_readdir_when_lstat_observes_cancellation() {
        let root = PathBuf::from("/source");
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let reader = FakeRemoteTreeReader {
            stats: HashMap::from([(root.clone(), fake_file_stat(0o040755, 0))]),
            cancel_after_lstat: Some(cancel_flag.clone()),
            ..FakeRemoteTreeReader::default()
        };

        let error = build_remote_transfer_manifest(
            &reader,
            &root,
            None,
            &cancel_flag,
            0,
            RemoteManifestPurpose::Download,
        )
        .err()
        .expect("a cancelled manifest must stop before its next network boundary");

        assert!(matches!(
            error,
            RemoteFsError::Other { ref message } if message == "download cancelled"
        ));
        assert_eq!(reader.stat_calls("/source"), 1);
        assert_eq!(reader.directory_calls("/source"), 0);
    }

    #[test]
    fn remote_directory_cache_deduplicates_known_upload_parent_checks() {
        let mut cache = RemoteDirectoryCache::new(Path::new("/destination"));
        let calls = std::cell::Cell::new(0);

        cache
            .ensure_with(Path::new("/destination"), |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .expect("known destination should remain valid");
        cache
            .ensure_with(Path::new("/destination/assets"), |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .expect("new upload directory should be ensured");
        cache
            .ensure_with(Path::new("/destination/assets"), |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .expect("known file parent should not be ensured again");

        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn remote_directory_cache_retries_failures_and_forgets_replaced_trees() {
        let mut cache = RemoteDirectoryCache::new(Path::new("/destination"));
        let path = Path::new("/destination/assets");
        let calls = std::cell::Cell::new(0);

        let error = cache
            .ensure_with(path, |_| {
                calls.set(calls.get() + 1);
                Err(RemoteFsError::Other {
                    message: "permission denied".to_string(),
                })
            })
            .expect_err("failed checks must remain visible");
        assert!(matches!(error, RemoteFsError::Other { .. }));
        cache
            .ensure_with(path, |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .expect("a failed directory check should be retried");
        cache.forget_tree(path);
        cache
            .ensure_with(path, |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .expect("a replaced directory should be ensured again");

        assert_eq!(calls.get(), 3);
    }

    fn connection_request(host: &str, port: u16, username: &str) -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth_method: crate::models::AuthMethod::Password,
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        }
    }

    fn jump_host(host: &str) -> crate::models::JumpHostConfig {
        crate::models::JumpHostConfig {
            host: host.to_string(),
            port: 22,
            username: "jump-user".to_string(),
            auth_method: crate::models::AuthMethod::Password,
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
        }
    }

    #[test]
    fn same_connection_target_matches_host_port_username() {
        let source = connection_request("example.com", 22, "alice");
        let destination = connection_request("example.com", 22, "alice");

        assert!(is_same_connection_target(&source, &destination));
    }

    #[test]
    fn same_connection_target_rejects_different_account() {
        let source = connection_request("example.com", 22, "alice");

        assert!(!is_same_connection_target(
            &source,
            &connection_request("example.com", 22, "bob")
        ));
        assert!(!is_same_connection_target(
            &source,
            &connection_request("example.com", 2222, "alice")
        ));
        assert!(!is_same_connection_target(
            &source,
            &connection_request("other.example.com", 22, "alice")
        ));
    }

    #[test]
    fn same_connection_target_matches_same_jump_route() {
        let mut source = connection_request("10.0.0.5", 22, "alice");
        let mut destination = connection_request("10.0.0.5", 22, "alice");
        source.jump_host = Some(jump_host("jump.example.com"));
        destination.jump_host = Some(jump_host("jump.example.com"));

        assert!(is_same_connection_target(&source, &destination));
    }

    #[test]
    fn same_connection_target_rejects_different_jump_route() {
        let mut source = connection_request("10.0.0.5", 22, "alice");
        let mut destination = connection_request("10.0.0.5", 22, "alice");
        source.jump_host = Some(jump_host("jump-a.example.com"));
        destination.jump_host = Some(jump_host("jump-b.example.com"));

        assert!(!is_same_connection_target(&source, &destination));
    }

    #[test]
    fn remote_identity_scope_includes_jump_route() {
        let mut request = connection_request("10.0.0.5", 22, "alice");
        request.jump_host = Some(jump_host("jump.example.com"));

        assert_eq!(
            remote_identity_scope(&request),
            "10.0.0.5:22:alice|jump=jump.example.com:22:jump-user"
        );
    }

    #[test]
    fn local_upload_scan_honours_cancellation() {
        let directory =
            std::env::temp_dir().join(format!("shellspan-scan-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let cancel_flag = Arc::new(AtomicBool::new(true));

        let error = scan_local_upload_path(&directory, &cancel_flag)
            .expect_err("cancelled scan should fail");

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("cancelled")),
            "expected a cancellation error, got {error:?}"
        );
        fs::remove_dir_all(directory).expect("clean test directory");
    }

    #[test]
    fn local_upload_scan_reports_file_count_and_bytes() {
        let directory = tempfile::tempdir().expect("create scan fixture");
        fs::create_dir(directory.path().join("nested")).expect("create nested fixture directory");
        fs::write(directory.path().join("first.bin"), [1_u8; 3]).expect("write first fixture");
        fs::write(directory.path().join("nested/second.bin"), [2_u8; 5])
            .expect("write second fixture");

        let stats = scan_local_upload_path(directory.path(), &Arc::new(AtomicBool::new(false)))
            .expect("scan fixture");

        assert_eq!(stats.total_bytes, 8);
        assert_eq!(stats.total_files, 2);
        assert_eq!(stats.total_steps, 4);
    }

    fn benchmark_env_u64(name: &str, default: u64) -> u64 {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default)
    }

    fn write_benchmark_file(path: &Path, size: u64) {
        let mut file = fs::File::create(path).expect("create benchmark file");
        let chunk = (0..64 * 1024)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut remaining = size;
        while remaining > 0 {
            let count = remaining.min(chunk.len() as u64) as usize;
            file.write_all(&chunk[..count])
                .expect("write benchmark file");
            remaining -= count as u64;
        }
        file.flush().expect("flush benchmark file");
    }

    fn local_benchmark_inventory(path: &Path) -> (u64, u64) {
        let metadata = fs::metadata(path).expect("read downloaded benchmark metadata");
        if metadata.is_file() {
            return (metadata.len(), 1);
        }
        let mut total_bytes = 0;
        let mut total_files = 0;
        for entry in fs::read_dir(path).expect("read downloaded benchmark directory") {
            let (bytes, files) =
                local_benchmark_inventory(&entry.expect("read benchmark entry").path());
            total_bytes += bytes;
            total_files += files;
        }
        (total_bytes, total_files)
    }

    fn take_transfer_metric(operation_id: &str) -> String {
        let mut records = TEST_TRANSFER_METRIC_RECORDS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = records
            .iter()
            .position(|record| record.contains(operation_id))
            .unwrap_or_else(|| panic!("missing transfer metrics for {operation_id}"));
        records.remove(index)
    }

    fn assert_benchmark_metric(
        record: &str,
        operation: &str,
        password: &str,
        total_bytes: u64,
        total_files: u64,
    ) {
        for field in [
            format!("operation={operation}"),
            "status=completed".to_string(),
            "connect_us=".to_string(),
            "scan_us=".to_string(),
            "transfer_us=".to_string(),
            "finalize_us=".to_string(),
            "total_us=".to_string(),
            format!("total_bytes={total_bytes}"),
            format!("file_count={total_files}"),
            "throughput_bytes_per_second=".to_string(),
        ] {
            assert!(record.contains(&field), "missing {field} in {record}");
        }
        assert!(
            !record.contains(password),
            "transfer metrics must not contain credentials"
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_sftp_transfer_benchmark() {
        let host =
            std::env::var("SHELLSPAN_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("SHELLSPAN_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username =
            std::env::var("SHELLSPAN_E2E_SSH_USERNAME").unwrap_or_else(|_| "shellspan".to_string());
        let password = std::env::var("SHELLSPAN_E2E_SSH_PASSWORD")
            .unwrap_or_else(|_| "shellspan-e2e".to_string());
        let iterations = benchmark_env_u64("SHELLSPAN_SFTP_BENCH_ITERATIONS", 3);
        let large_bytes = benchmark_env_u64("SHELLSPAN_SFTP_BENCH_LARGE_BYTES", 16 * 1024 * 1024);
        let small_file_count = benchmark_env_u64("SHELLSPAN_SFTP_BENCH_SMALL_FILE_COUNT", 128);
        let small_file_bytes = benchmark_env_u64("SHELLSPAN_SFTP_BENCH_SMALL_FILE_BYTES", 4 * 1024);
        let transfer_buffer_bytes = transfer_buffer_size();
        let connection = RemoteConnectionRequest {
            host: host.clone(),
            port,
            username,
            auth_method: crate::models::AuthMethod::Password,
            password: Some(password.clone()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let (_known_hosts_temp, known_hosts) =
            crate::connection::trusted_known_hosts_fixture(&host, port);
        let local_root = tempfile::tempdir().expect("create benchmark workspace");
        let remote_root = format!(
            "/home/shellspan/upload/shellspan-benchmark-{}",
            Uuid::new_v4()
        );
        let emitter = NoopTransferEventEmitter;
        TEST_TRANSFER_METRIC_RECORDS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();

        let large_path = local_root.path().join("large.bin");
        write_benchmark_file(&large_path, large_bytes);
        let small_directory = local_root.path().join("small-files");
        fs::create_dir(&small_directory).expect("create small-file benchmark directory");
        for index in 0..small_file_count {
            write_benchmark_file(
                &small_directory.join(format!("file-{index:04}.bin")),
                small_file_bytes,
            );
        }

        for (scenario, local_path, source_name, total_bytes, total_files) in [
            (
                "large-file",
                large_path.as_path(),
                "large.bin",
                large_bytes,
                1,
            ),
            (
                "many-small-files",
                small_directory.as_path(),
                "small-files",
                small_file_count * small_file_bytes,
                small_file_count,
            ),
        ] {
            for iteration in 1..=iterations {
                let case_root = format!("{remote_root}/{scenario}/{iteration}");
                let upload_directory = format!("{case_root}/upload");
                let copy_directory = format!("{case_root}/copy");
                let uploaded_path = format!("{upload_directory}/{source_name}");
                let copied_path = format!("{copy_directory}/{source_name}");
                let download_directory = local_root
                    .path()
                    .join(format!("download-{scenario}-{iteration}"));
                let id_prefix = format!("sftp-benchmark-{scenario}-{iteration}");
                let upload_id = format!("{id_prefix}-upload");
                let copy_id = format!("{id_prefix}-copy");
                let download_id = format!("{id_prefix}-download");

                let upload = upload_local_paths_inner(
                    emitter,
                    UploadLocalPathsRequest {
                        connection: connection.clone(),
                        destination_directory: upload_directory,
                        local_paths: vec![path_to_string(local_path)],
                        conflict_policies: Vec::new(),
                        operation_id: upload_id.clone(),
                    },
                    Arc::new(AtomicBool::new(false)),
                    Some(&known_hosts),
                )
                .expect("benchmark upload should succeed");
                assert!(
                    upload
                        .items
                        .iter()
                        .all(|item| item.status == TransferItemStatus::Completed),
                    "every benchmark upload item should complete"
                );

                copy_remote_to_remote_blocking(
                    emitter,
                    CopyRemoteToRemoteRequest {
                        source_connection: connection.clone(),
                        destination_connection: connection.clone(),
                        source_paths: vec![uploaded_path],
                        destination_directory: copy_directory,
                        conflict_policies: Vec::new(),
                        operation_id: copy_id.clone(),
                    },
                    Arc::new(AtomicBool::new(false)),
                    None,
                    Some(&known_hosts),
                )
                .expect("benchmark remote copy should succeed");

                let download = download_remote_paths_inner(
                    emitter,
                    DownloadRemotePathsRequest {
                        connection: connection.clone(),
                        remote_paths: vec![copied_path],
                        destination_directory: path_to_string(&download_directory),
                        conflict_policies: Vec::new(),
                        operation_id: download_id.clone(),
                    },
                    Arc::new(AtomicBool::new(false)),
                    Some(&known_hosts),
                )
                .expect("benchmark download should succeed");
                assert!(
                    download
                        .items
                        .iter()
                        .all(|item| item.status == TransferItemStatus::Completed),
                    "every benchmark download item should complete"
                );
                assert_eq!(
                    local_benchmark_inventory(&download_directory.join(source_name)),
                    (total_bytes, total_files),
                    "downloaded benchmark inventory should match the source"
                );

                for (operation_id, operation) in [
                    (&upload_id, "upload"),
                    (&copy_id, "remote_copy"),
                    (&download_id, "download"),
                ] {
                    let record = take_transfer_metric(operation_id);
                    assert_benchmark_metric(
                        &record,
                        operation,
                        &password,
                        total_bytes,
                        total_files,
                    );
                    println!(
                        "SFTP_BENCHMARK scenario={scenario} iteration={iteration} transfer_buffer_bytes={transfer_buffer_bytes} {record}"
                    );
                }
            }
        }

        let connected = connect_sftp(&connection, None, Some(&known_hosts))
            .expect("connect for benchmark cleanup");
        let connected = connected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        remove_remote_entry_simple(&connected.sftp, Path::new(&remote_root))
            .expect("remove remote benchmark fixtures");
    }
