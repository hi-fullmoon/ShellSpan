    use super::*;
    use tempfile::TempDir;

    fn make_request(
        sources: Vec<&str>,
        destination: &str,
        policies: Vec<UploadConflictPolicy>,
    ) -> CopyLocalPathsRequest {
        CopyLocalPathsRequest {
            source_paths: sources.into_iter().map(|s| s.to_string()).collect(),
            destination_directory: destination.to_string(),
            conflict_policies: policies,
            operation_id: "test-op".to_string(),
        }
    }

    #[test]
    fn previews_a_local_utf8_file() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("notes.txt");
        fs::write(&source, "hello\nworld").unwrap();

        let response = read_local_file_blocking(source.to_string_lossy().to_string()).unwrap();

        assert_eq!(response.name, "notes.txt");
        assert_eq!(response.content, "hello\nworld");
        assert_eq!(response.content_encoding, "utf8");
        assert!(response.is_text);
        assert!(!response.truncated);
    }

    #[test]
    fn previews_local_binary_data_as_base64() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("image.png");
        fs::write(&source, [0_u8, 1, 2]).unwrap();

        let response = read_local_file_blocking(source.to_string_lossy().to_string()).unwrap();

        assert_eq!(response.content, "AAEC");
        assert_eq!(response.content_encoding, "base64");
        assert!(!response.is_text);
        assert!(!response.truncated);
    }

    #[test]
    fn returns_metadata_without_loading_an_oversized_complete_file() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("large.mp4");
        let file = fs::File::create(&source).unwrap();
        file.set_len(PREVIEW_COMPLETE_FILE_SIZE_LIMIT + 1).unwrap();

        let response = read_local_file_blocking(source.to_string_lossy().to_string()).unwrap();

        assert_eq!(response.content_encoding, "none");
        assert!(response.content.is_empty());
        assert!(response.truncated);
        assert_eq!(response.size, PREVIEW_COMPLETE_FILE_SIZE_LIMIT + 1);
    }

    #[test]
    fn keeps_a_bounded_prefix_for_large_local_text_files() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("large.log");
        fs::write(
            &source,
            vec![b'a'; (PREVIEW_TEXT_PREFIX_SIZE_LIMIT + 32) as usize],
        )
        .unwrap();

        let response = read_local_file_blocking(source.to_string_lossy().to_string()).unwrap();

        assert_eq!(response.content_encoding, "utf8");
        assert_eq!(
            response.content.len(),
            PREVIEW_TEXT_PREFIX_SIZE_LIMIT as usize
        );
        assert!(response.truncated);
    }

    #[test]
    fn rejects_local_directories_for_preview() {
        let temp = TempDir::new().unwrap();

        let result = read_local_file_blocking(temp.path().to_string_lossy().to_string());

        assert_eq!(result.unwrap_err(), "cannot preview a directory");
    }

    #[test]
    fn copies_a_single_file_into_destination() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::write(&src, "hello").unwrap();

        let request = make_request(
            vec![src.to_str().unwrap()],
            dest_dir.to_str().unwrap(),
            vec![],
        );
        copy_local_paths_blocking(request).unwrap();

        let copied = dest_dir.join("file.txt");
        assert!(copied.exists());
        assert_eq!(fs::read_to_string(copied).unwrap(), "hello");
    }

    #[test]
    fn copies_a_nested_directory_recursively() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        let nested = src_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("inner.txt"), "inner").unwrap();
        let dest_dir = temp.path().join("dest");

        let request = make_request(
            vec![src_dir.to_str().unwrap()],
            dest_dir.to_str().unwrap(),
            vec![],
        );
        copy_local_paths_blocking(request).unwrap();

        assert!(dest_dir.join("src").exists());
        assert!(dest_dir.join("src/nested/inner.txt").exists());
    }

    #[test]
    fn overwrite_replaces_existing_file() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(
            vec![src.to_str().unwrap()],
            dest_dir.to_str().unwrap(),
            vec![UploadConflictPolicy::Overwrite],
        );
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(
            fs::read_to_string(dest_dir.join("file.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn skip_leaves_existing_file_unchanged() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(
            vec![src.to_str().unwrap()],
            dest_dir.to_str().unwrap(),
            vec![UploadConflictPolicy::Skip],
        );
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(
            fs::read_to_string(dest_dir.join("file.txt")).unwrap(),
            "old"
        );
    }

    #[test]
    fn fail_errors_on_existing_file() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(
            vec![src.to_str().unwrap()],
            dest_dir.to_str().unwrap(),
            vec![UploadConflictPolicy::Fail],
        );
        let result = copy_local_paths_blocking(request);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("file.txt"));
    }

    #[test]
    fn replace_replaces_existing_directory_contents() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        let src_nested = src_dir.join("nested");
        fs::create_dir_all(&src_nested).unwrap();
        fs::write(src_nested.join("new.txt"), "new").unwrap();

        let dest_dir = temp.path().join("dest");
        let dest_existing = dest_dir.join("src");
        let dest_existing_nested = dest_existing.join("nested");
        fs::create_dir_all(&dest_existing_nested).unwrap();
        fs::write(dest_existing_nested.join("old.txt"), "old").unwrap();

        let request = make_request(
            vec![src_dir.to_str().unwrap()],
            dest_dir.to_str().unwrap(),
            vec![UploadConflictPolicy::Replace],
        );
        copy_local_paths_blocking(request).unwrap();

        assert!(dest_existing.join("nested/new.txt").exists());
        assert!(!dest_existing_nested.join("old.txt").exists());
    }

    #[test]
    fn overwrite_file_onto_itself_is_a_noop() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("file.txt");
        fs::write(&source, "unchanged").unwrap();

        let request = make_request(
            vec![source.to_str().unwrap()],
            temp.path().to_str().unwrap(),
            vec![UploadConflictPolicy::Overwrite],
        );
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(fs::read_to_string(source).unwrap(), "unchanged");
    }

    #[test]
    fn replace_directory_onto_itself_is_a_noop() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("keep.txt"), "unchanged").unwrap();

        let request = make_request(
            vec![source.to_str().unwrap()],
            temp.path().to_str().unwrap(),
            vec![UploadConflictPolicy::Replace],
        );
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(
            fs::read_to_string(source.join("keep.txt")).unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn copy_rejects_directory_into_its_descendant() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let nested_destination = source.join("nested");
        fs::create_dir_all(&nested_destination).unwrap();
        fs::write(source.join("keep.txt"), "unchanged").unwrap();

        let request = make_request(
            vec![source.to_str().unwrap()],
            nested_destination.to_str().unwrap(),
            vec![],
        );
        let result = copy_local_paths_blocking(request);

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(source.join("keep.txt")).unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn renames_a_file_within_the_same_directory() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("old.txt");
        fs::write(&src, "hello").unwrap();

        rename_local_path_blocking(src.to_str().unwrap().to_string(), "new.txt".to_string())
            .unwrap();

        assert!(!src.exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("new.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn rename_fails_when_target_name_exists() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("old.txt"), "a").unwrap();
        fs::write(temp.path().join("new.txt"), "b").unwrap();

        let result = rename_local_path_blocking(
            temp.path().join("old.txt").to_str().unwrap().to_string(),
            "new.txt".to_string(),
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(temp.path().join("old.txt")).unwrap(),
            "a"
        );
    }

    #[test]
    fn rename_rejects_empty_and_separator_names() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("old.txt");
        fs::write(&src, "a").unwrap();

        assert!(
            rename_local_path_blocking(src.to_str().unwrap().to_string(), "  ".to_string())
                .is_err()
        );
        assert!(
            rename_local_path_blocking(src.to_str().unwrap().to_string(), "a/b".to_string())
                .is_err()
        );
        assert!(
            rename_local_path_blocking(src.to_str().unwrap().to_string(), "a\\b".to_string())
                .is_err()
        );
        assert!(src.exists());
    }

    #[test]
    fn paste_copies_file_without_conflict() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        let src = src_dir.join("report.txt");
        fs::write(&src, "data").unwrap();
        let dest = temp.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            dest.to_str().unwrap().to_string(),
            "copy".to_string(),
        )
        .unwrap();

        assert_eq!(written.len(), 1);
        assert_eq!(fs::read_to_string(dest.join("report.txt")).unwrap(), "data");
    }

    #[test]
    fn paste_auto_renames_on_conflict() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("report.txt");
        fs::write(&src, "new").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "copy".to_string(),
        )
        .unwrap();

        assert_eq!(
            written,
            vec![portable_local_path(&temp.path().join("report copy.txt"))]
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("report copy.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn paste_increments_suffix_for_repeated_conflicts() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("report.txt"), "0").unwrap();
        fs::write(temp.path().join("report copy.txt"), "1").unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        let src = src_dir.join("report.txt");
        fs::write(&src, "new").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "copy".to_string(),
        )
        .unwrap();

        assert!(written[0].ends_with("report copy 2.txt"));
    }

    #[test]
    fn paste_auto_renames_directories_and_extensionless_files() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        fs::create_dir(src_dir.join("docs")).unwrap();
        fs::write(src_dir.join("docs/a.txt"), "a").unwrap();
        fs::write(src_dir.join("Makefile"), "m").unwrap();
        let dest = temp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        fs::create_dir(dest.join("docs")).unwrap();
        fs::write(dest.join("Makefile"), "old").unwrap();

        let written = paste_local_paths_blocking(
            vec![
                src_dir.join("docs").to_str().unwrap().to_string(),
                src_dir.join("Makefile").to_str().unwrap().to_string(),
            ],
            dest.to_str().unwrap().to_string(),
            "copy".to_string(),
        )
        .unwrap();

        assert!(dest.join("docs copy/a.txt").exists());
        assert_eq!(fs::read_to_string(dest.join("Makefile copy")).unwrap(), "m");
        assert_eq!(written.len(), 2);
    }

    #[test]
    fn paste_rejects_directory_into_its_descendant() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let nested_destination = source.join("nested");
        fs::create_dir_all(&nested_destination).unwrap();
        fs::write(source.join("keep.txt"), "unchanged").unwrap();

        let result = paste_local_paths_blocking(
            vec![source.to_str().unwrap().to_string()],
            nested_destination.to_str().unwrap().to_string(),
            "copy".to_string(),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(source.join("keep.txt")).unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn paste_uses_localized_suffix() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("报告.txt");
        fs::write(&src, "data").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "副本".to_string(),
        )
        .unwrap();

        assert!(written[0].ends_with("报告 副本.txt"));
    }

    #[test]
    fn trash_rejects_empty_path_list() {
        let result = trash_local_paths_blocking(vec![]);
        assert!(result.is_err());
    }

    #[test]
    fn trash_fails_for_missing_path() {
        let temp = TempDir::new().unwrap();
        let missing = temp.path().join("does-not-exist.txt");
        let result = trash_local_paths_blocking(vec![missing.to_str().unwrap().to_string()]);
        assert!(result.is_err());
    }
