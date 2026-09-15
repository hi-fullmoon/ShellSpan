    use super::*;
    fn target(root: &std::path::Path) -> super::super::AgentSessionTarget {
        super::super::AgentSessionTarget {
            kind: "local".into(),
            target_id: "target".into(),
            session_id: "terminal".into(),
            label: None,
            profile_id: None,
            host: None,
            port: None,
            username: None,
            cwd: Some(
                std::fs::canonicalize(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into(),
            ),
            root_path: None,
            local_root: None,
        }
    }
    fn write(root: &std::path::Path, path: &str, name: &str, extra: &str) {
        let path = root.join(".agents/skills").join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!("---\nname: {name}\ndescription: useful\n{extra}---\ncomplete instructions\n"),
        )
        .unwrap();
    }
    fn read(root: &std::path::Path, expected_scope: Option<SkillScope>) -> SkillReadResult {
        read_local(SkillReadRequest {
            target: target(root),
            expected_scope,
            cancellation: CancellationToken::new(),
        })
    }
    #[test]
    fn skill_real_local_discovery_duplicates_shadcn_and_shallow_scope() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "a.md",
            "same",
            "disable-model-invocation: true\n",
        );
        write(root.path(), "z/SKILL.md", "same", "");
        write(root.path(), "nested/deeper/SKILL.md", "hidden", "");
        let shadcn = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.agents/skills/shadcn/SKILL.md");
        std::fs::copy(shadcn, root.path().join(".agents/skills/shadcn.md")).unwrap();
        let result = read(root.path(), None);
        assert_eq!(result.observation.status, SkillObservationStatus::Complete);
        assert_eq!(result.definitions.len(), 2);
        assert!(!result.definitions[0].entry.model_invocable);
        assert!(result
            .observation
            .diagnostics
            .iter()
            .any(|d| d.code == "shadowed" && d.message.contains("a.md")));
        assert!(result
            .observation
            .diagnostics
            .iter()
            .any(|d| d.code == "unknownMetadata"));
    }
    #[test]
    fn skill_refresh_empty_rebuild_body_and_root_drift() {
        let root = tempfile::tempdir().unwrap();
        let first = read(root.path(), None);
        assert_eq!(first.observation.status, SkillObservationStatus::Complete);
        let scope = first.observation.snapshot.unwrap().scope;
        write(root.path(), "one.md", "one", "");
        let second = read(root.path(), Some(scope.clone()));
        assert_eq!(second.definitions.len(), 1);
        std::fs::write(root.path().join("ordinary-file"), "normal work").unwrap();
        assert_eq!(
            read(root.path(), Some(scope.clone())).observation.status,
            SkillObservationStatus::Complete
        );
        std::fs::remove_dir_all(root.path().join(".agents/skills")).unwrap();
        assert_eq!(read(root.path(), Some(scope.clone())).definitions.len(), 0);
        let other = tempfile::tempdir().unwrap();
        assert_eq!(
            read(other.path(), Some(scope)).observation.status,
            SkillObservationStatus::Unavailable
        );
    }
    #[test]
    fn skill_local_symlinks_limits_and_cancellation_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "one.md", "one", "");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), root.path().join("link")).unwrap();
            let mut t = target(root.path());
            t.cwd = Some(root.path().join("link").to_str().unwrap().into());
            assert_eq!(
                read_local(SkillReadRequest {
                    target: t,
                    expected_scope: None,
                    cancellation: CancellationToken::new()
                })
                .observation
                .status,
                SkillObservationStatus::Unavailable
            );
        }
        std::fs::write(
            root.path().join(".agents/skills/one.md"),
            vec![b'x'; MAX_SKILL_FILE + 1],
        )
        .unwrap();
        assert_eq!(
            read(root.path(), None).observation.status,
            SkillObservationStatus::Incomplete
        );
        let token = CancellationToken::new();
        token.cancel();
        let r = read_local(SkillReadRequest {
            target: target(root.path()),
            expected_scope: None,
            cancellation: token,
        });
        assert_eq!(r.observation.status, SkillObservationStatus::Incomplete);
        let mut remote = target(root.path());
        remote.kind = "remote".into();
        remote.local_root = remote.cwd.clone();
        assert!(read_local(SkillReadRequest {
            target: remote,
            expected_scope: None,
            cancellation: CancellationToken::new()
        })
        .definitions
        .is_empty());
    }
    #[test]
    fn skill_partial_enumeration_permission_deadline_and_total_limits_are_incomplete() {
        use std::cell::Cell;
        struct Failing {
            local: LocalScopedReader,
            mode: u8,
            lists: Cell<usize>,
        }
        impl ScopedReader for Failing {
            fn root(&self) -> &str {
                self.local.root()
            }
            fn identity(&self) -> &str {
                self.local.identity()
            }
            fn check_root(&self) -> Result<(), ScopeReadError> {
                self.local.check_root()
            }
            fn list(
                &self,
                p: &str,
                n: usize,
                c: &ReadControl,
            ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
                self.lists.set(self.lists.get() + 1);
                if self.mode == 0 || self.mode == 3 && self.lists.get() > 1 {
                    Err(ScopeReadError::Io)
                } else {
                    self.local.list(p, n, c)
                }
            }
            fn read(&self, p: &str, n: usize, c: &ReadControl) -> Result<Vec<u8>, ScopeReadError> {
                match self.mode {
                    1 => Err(ScopeReadError::Io),
                    2 => Err(ScopeReadError::Denied),
                    _ => self.local.read(p, n, c),
                }
            }
        }
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "one.md", "one", "");
        let request = SkillReadRequest {
            target: target(root.path()),
            expected_scope: None,
            cancellation: CancellationToken::new(),
        };
        for mode in 0..5 {
            let reader = Failing {
                local: LocalScopedReader::open(request.target.cwd.as_deref().unwrap()).unwrap(),
                mode,
                lists: Cell::new(0),
            };
            let control = ReadControl {
                cancellation: CancellationToken::new(),
                deadline: Instant::now()
                    + if mode == 4 {
                        Duration::ZERO
                    } else {
                        Duration::from_secs(5)
                    },
            };
            let result = discover(&reader, &request, &control);
            assert_eq!(
                result.observation.status,
                SkillObservationStatus::Incomplete
            );
            assert!(result.observation.snapshot.is_none());
        }
        for count in [64, 65] {
            let total = tempfile::tempdir().unwrap();
            let directory = total.path().join(".agents/skills");
            std::fs::create_dir_all(&directory).unwrap();
            for i in 0..count {
                let mut bytes =
                    format!("---\nname: skill-{i}\ndescription: short\n---\n").into_bytes();
                bytes.resize(MAX_SKILL_FILE, b'x');
                std::fs::write(directory.join(format!("{i}.md")), bytes).unwrap();
            }
            assert_eq!(
                read(total.path(), None).observation.status,
                if count == 64 {
                    SkillObservationStatus::Complete
                } else {
                    SkillObservationStatus::Incomplete
                }
            );
        }
        for (count, files) in [(256, true), (257, true), (1024, false), (1025, false)] {
            let many = tempfile::tempdir().unwrap();
            let directory = many.path().join(".agents/skills");
            std::fs::create_dir_all(&directory).unwrap();
            for i in 0..count {
                if files {
                    write(many.path(), &format!("{i}.md"), &format!("s-{i}"), "");
                } else {
                    std::fs::create_dir(directory.join(i.to_string())).unwrap();
                }
            }
            assert_eq!(
                read(many.path(), None).observation.status,
                if count == 256 || count == 1024 {
                    SkillObservationStatus::Complete
                } else {
                    SkillObservationStatus::Incomplete
                }
            );
        }
    }
