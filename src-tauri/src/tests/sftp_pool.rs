    use super::*;
    use crate::models::{AuthMethod, RemoteConnectionRequest};

    fn sample_request() -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        }
    }

    fn begin_leader(pool: &SftpPool, key: &ConnectionKey) -> ConnectLeaderGuard {
        match pool.begin_connect(key) {
            ConnectClaim::Leader(guard) => guard,
            ConnectClaim::Follower(_) => panic!("first claim must be the leader"),
        }
    }

    fn follower_failure(error: ConnectionError) -> ConnectionError {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let leader = begin_leader(&pool, &key);
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot, None));
        assert!(pool.finish_connect(&leader, Err(error)).is_err());

        let result = waiter.join().expect("follower thread should finish");
        drop(leader);
        match result {
            Err(error) => error,
            Ok(_) => panic!("follower unexpectedly received a connection"),
        }
    }

    #[test]
    fn invalidate_does_not_panic_on_empty_pool() {
        let pool = SftpPool::default();
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        pool.invalidate(&request);
        assert!(pool.get(&request).is_none());
    }

    #[test]
    fn health_check_is_only_required_after_verification_threshold() {
        // Freshly verified entries skip the realpath round-trip; entries last
        // verified at or beyond the window are re-checked.
        assert!(!should_health_check(Duration::from_secs(29)));
        assert!(should_health_check(Duration::from_secs(30)));
    }

    #[test]
    fn pool_lookup_returns_a_distinct_abort_error() {
        let pool = SftpPool::default();
        let aborted = AtomicBool::new(true);

        match pool.get_with_abort(&sample_request(), Some(&aborted)) {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, SFTP_POOL_GET_ABORTED_MESSAGE);
            }
            Err(error) => panic!("unexpected pool lookup error: {error:?}"),
            Ok(_) => panic!("aborted pool lookup unexpectedly continued"),
        }
    }

    #[test]
    fn aborted_follower_exits_without_releasing_the_shared_leader() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let leader = begin_leader(&pool, &key);
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };
        let aborted = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = std::sync::mpsc::channel();

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter_slot = slot.clone();
        let waiter_abort = aborted.clone();
        let waiter = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            waiter_pool.wait_connect(&waiter_key, waiter_slot, Some(&waiter_abort))
        });

        started_rx.recv().unwrap();
        aborted.store(true, Ordering::SeqCst);
        // Avoid making the test depend on the polling interval when the waiter
        // is already asleep. If this notification races ahead of the wait, the
        // bounded slice still guarantees another cancellation check.
        slot.ready.notify_all();

        match waiter.join().expect("follower thread should finish") {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, SFTP_POOL_GET_ABORTED_MESSAGE);
            }
            Err(error) => panic!("unexpected follower error: {error:?}"),
            Ok(_) => panic!("aborted follower unexpectedly received a connection"),
        }
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot)));
        assert!(matches!(
            *slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            ConnectState::Pending
        ));

        assert!(pool
            .finish_connect(
                &leader,
                Err(ConnectionError::Other {
                    message: "test cleanup".to_string(),
                }),
            )
            .is_err());
    }

    #[test]
    fn follower_wait_slices_bound_cancellation_latency_without_shortening_the_deadline() {
        assert_eq!(
            follower_wait_slice(Duration::from_secs(1)),
            SFTP_CONNECT_WAIT_POLL_INTERVAL
        );
        assert_eq!(
            follower_wait_slice(Duration::from_millis(10)),
            Duration::from_millis(10)
        );
    }

    #[test]
    fn health_probe_rechecks_abort_after_lock_before_network_work() {
        let connection = Mutex::new(());
        let connected = connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let aborted = AtomicBool::new(true);
        let probe_called = AtomicBool::new(false);

        let result = run_health_probe_after_lock(connected, Some(&aborted), |_| {
            probe_called.store(true, Ordering::SeqCst);
            true
        });

        match result {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, SFTP_POOL_GET_ABORTED_MESSAGE);
            }
            Err(error) => panic!("unexpected health probe error: {error:?}"),
            Ok(_) => panic!("aborted health probe unexpectedly ran"),
        }
        assert!(!probe_called.load(Ordering::SeqCst));
    }

    #[test]
    fn begin_connect_grants_leadership_to_only_one_caller() {
        let pool = SftpPool::default();
        let request = sample_request();
        let key = connection_key(&request);

        // The leader guard must stay bound: dropping it aborts the slot.
        let leader = begin_leader(&pool, &key);
        assert!(matches!(
            pool.begin_connect(&key),
            ConnectClaim::Follower(_)
        ));

        // Once the leader finishes, the slot is released and the next caller
        // becomes the leader again.
        pool.finish_connect(
            &leader,
            Err(crate::models::ConnectionError::Other {
                message: "boom".to_string(),
            }),
        )
        .ok();
        drop(leader);
        assert!(matches!(pool.begin_connect(&key), ConnectClaim::Leader(_)));
    }

    #[test]
    fn leader_guard_drop_fails_pending_slot() {
        // Simulates a leader panicking between begin_connect and
        // finish_connect: dropping the guard must wake followers with a
        // failure instead of letting them wait forever.
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());

        let guard = match pool.begin_connect(&key) {
            ConnectClaim::Leader(guard) => guard,
            ConnectClaim::Follower(_) => panic!("first claim must be the leader"),
        };
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot, None));
        drop(guard);

        let result = waiter.join().expect("follower thread should finish");
        match result {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, "connection attempt aborted");
            }
            Err(error) => panic!("unexpected follower error: {error:?}"),
            Ok(_) => panic!("follower unexpectedly received a connection"),
        }

        // The slot is released, so the next caller becomes the leader again.
        assert!(matches!(pool.begin_connect(&key), ConnectClaim::Leader(_)));
    }

    #[test]
    fn stale_leader_finish_and_drop_leave_replacement_generation_untouched() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let old_leader = begin_leader(&pool, &key);
        let old_slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        // Deterministically simulate the timeout path releasing the old slot so
        // a retry can install a new generation while the old handshake is still
        // running.
        {
            let mut in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(in_flight
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &old_slot)));
            in_flight.remove(&key);
        }

        let replacement_leader = begin_leader(&pool, &key);
        let replacement_slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("replacement follower became a leader"),
        };

        assert!(pool
            .finish_connect(
                &old_leader,
                Err(ConnectionError::Other {
                    message: "old generation failed".to_string(),
                }),
            )
            .is_err());

        {
            let state = old_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(
                &*state,
                ConnectState::Failed(ConnectionError::Other { message })
                    if message == "old generation failed"
            ));
        }
        {
            let state = replacement_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(*state, ConnectState::Pending));
        }
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &replacement_slot)));

        // Dropping the completed old guard must still use slot identity and
        // leave the replacement claimed and pending.
        drop(old_leader);
        {
            let state = replacement_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(*state, ConnectState::Pending));
        }
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &replacement_slot)));

        // Resolve the replacement normally so its guard has no pending work on
        // drop and the test leaves no in-flight generation behind.
        assert!(pool
            .finish_connect(
                &replacement_leader,
                Err(ConnectionError::Other {
                    message: "replacement failed".to_string(),
                }),
            )
            .is_err());
    }

    #[test]
    fn stale_success_skips_reusable_pool_publish_while_replacement_is_active() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let old_leader = begin_leader(&pool, &key);
        let old_slot = old_leader.slot.clone();

        {
            let mut in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            in_flight.remove(&key);
        }
        let replacement_leader = begin_leader(&pool, &key);

        let owns_generation = {
            let in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            connect_generation_is_current(&in_flight, &old_leader)
        };
        let publish_calls = std::cell::Cell::new(0);
        let returned = publish_connection_if_current(owns_generation, "old", |connection| {
            publish_calls.set(publish_calls.get() + 1);
            connection
        });

        assert_eq!(returned, "old");
        assert_eq!(publish_calls.get(), 0, "stale success polluted the pool");
        let replacement_owns_generation = {
            let in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            connect_generation_is_current(&in_flight, &replacement_leader)
        };
        let returned = publish_connection_if_current(
            replacement_owns_generation,
            "replacement",
            |connection| {
                publish_calls.set(publish_calls.get() + 1);
                connection
            },
        );
        assert_eq!(returned, "replacement");
        assert_eq!(
            publish_calls.get(),
            1,
            "current success did not publish exactly once"
        );
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &replacement_leader.slot)));
        assert!(matches!(
            *old_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            ConnectState::Pending
        ));

        // Complete both synthetic generations through failure paths because a
        // unit ConnectedSftp requires a real SSH server; the success-specific
        // reusable-publish decision above is generic and counted directly.
        assert!(pool
            .finish_connect(
                &old_leader,
                Err(ConnectionError::Other {
                    message: "old cleanup".to_string(),
                }),
            )
            .is_err());
        assert!(pool
            .finish_connect(
                &replacement_leader,
                Err(ConnectionError::Other {
                    message: "replacement cleanup".to_string(),
                }),
            )
            .is_err());
    }

    #[test]
    fn wait_connect_follower_receives_leader_failure() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());

        let leader = begin_leader(&pool, &key);
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot, None));
        pool.finish_connect(
            &leader,
            Err(crate::models::ConnectionError::Other {
                message: "handshake failed".to_string(),
            }),
        )
        .ok();

        let result = waiter.join().expect("follower thread should finish");
        match result {
            Err(ConnectionError::Other { message }) => assert_eq!(message, "handshake failed"),
            Err(error) => panic!("unexpected follower error: {error:?}"),
            Ok(_) => panic!("follower unexpectedly received a connection"),
        }
        drop(leader);
    }

    #[test]
    fn wait_connect_follower_preserves_unknown_host_key_classification() {
        let error = follower_failure(ConnectionError::HostKeyUnknown {
            host: "unknown.example.com".to_string(),
            port: 2222,
            fingerprint: Some("ED25519 SHA256:test".to_string()),
        });

        match error {
            ConnectionError::HostKeyUnknown {
                host,
                port,
                fingerprint,
            } => {
                assert_eq!(host, "unknown.example.com");
                assert_eq!(port, 2222);
                assert_eq!(fingerprint.as_deref(), Some("ED25519 SHA256:test"));
            }
            error => panic!("unexpected follower error: {error:?}"),
        }
    }

    #[test]
    fn wait_connect_follower_preserves_mismatched_host_key_classification() {
        let error = follower_failure(ConnectionError::HostKeyMismatch {
            host: "changed.example.com".to_string(),
            port: 22,
            fingerprint: Some("ED25519 SHA256:changed".to_string()),
        });

        match error {
            ConnectionError::HostKeyMismatch {
                host,
                port,
                fingerprint,
            } => {
                assert_eq!(host, "changed.example.com");
                assert_eq!(port, 22);
                assert_eq!(fingerprint.as_deref(), Some("ED25519 SHA256:changed"));
            }
            error => panic!("unexpected follower error: {error:?}"),
        }
    }

    #[test]
    fn connection_key_is_stable_for_equal_requests() {
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        assert_eq!(connection_key(&request), connection_key(&request));
    }

    #[test]
    fn connection_key_differs_when_credentials_differ() {
        let base = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let mut other = base.clone();
        other.username = "bob".to_string();

        assert_ne!(connection_key(&base), connection_key(&other));
    }

    #[test]
    fn connection_key_distinguishes_none_and_empty_string() {
        let with_empty = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let with_none = RemoteConnectionRequest {
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            ..with_empty.clone()
        };

        assert_ne!(connection_key(&with_empty), connection_key(&with_none));
    }

    #[test]
    fn connection_key_distinguishes_some_value_from_matching_prefix() {
        // Ensure Some("none") does not collide with None and Some("foo") does not
        // collide with any other field.
        let base = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("none".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let with_none_password = RemoteConnectionRequest {
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            ..base.clone()
        };

        assert_ne!(connection_key(&base), connection_key(&with_none_password));
    }

    #[test]
    fn connection_key_does_not_contain_raw_secrets() {
        let host_pass = "super-secret-password";
        let host_phrase = "super-secret-passphrase";
        let host_key_data = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123";
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some(host_pass.to_string()),
            keychain_key_id: None,
            private_key_data: Some(host_key_data.to_string()),
            passphrase: Some(host_phrase.to_string()),
            jump_host: None,
        };

        let key = connection_key(&request);

        assert!(
            !key.host.contains(host_pass),
            "key must not contain raw password"
        );
        assert!(
            !key.passphrase_hash.contains(host_phrase),
            "key must not contain raw passphrase"
        );
        assert!(
            !key.private_key_data_hash.contains(host_key_data),
            "key must not contain raw private key data"
        );
    }

    #[test]
    fn connection_key_does_not_contain_jump_host_raw_secrets() {
        let jump_pass = "jump-secret-password";
        let jump_phrase = "jump-secret-passphrase";
        let jump_key_data = "-----BEGIN OPENSSH PRIVATE KEY-----\njump-key-data";
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("host-password".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "jump.example.com".to_string(),
                port: 22,
                username: "jump".to_string(),
                auth_method: AuthMethod::Key,
                password: Some(jump_pass.to_string()),
                keychain_key_id: None,
                private_key_data: Some(jump_key_data.to_string()),
                passphrase: Some(jump_phrase.to_string()),
            }),
        };

        let key = connection_key(&request);
        let jump_host_key = key.jump_host.as_ref().expect("jump host key present");

        assert!(
            !jump_host_key.password_hash.contains(jump_pass),
            "key must not contain raw jump-host password"
        );
        assert!(
            !jump_host_key.passphrase_hash.contains(jump_phrase),
            "key must not contain raw jump-host passphrase"
        );
        assert!(
            !jump_host_key.private_key_data_hash.contains(jump_key_data),
            "key must not contain raw jump-host private key data"
        );
    }

    #[test]
    fn equal_credentials_produce_equal_keys() {
        let base = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: Some("key-data".to_string()),
            passphrase: Some("phrase".to_string()),
            jump_host: Some(JumpHostConfig {
                host: "jump.example.com".to_string(),
                port: 22,
                username: "jump".to_string(),
                auth_method: AuthMethod::Key,
                password: Some("jump-secret".to_string()),
                keychain_key_id: None,
                private_key_data: Some("jump-key-data".to_string()),
                passphrase: Some("jump-phrase".to_string()),
            }),
        };
        let identical = base.clone();

        assert_eq!(connection_key(&base), connection_key(&identical));
    }

    #[test]
    fn connection_key_distinguishes_colon_in_host_and_username() {
        // A structured key must not collide when user-controlled strings contain
        // delimiters that would have merged fields in the old format-string key.
        let first = RemoteConnectionRequest {
            host: "example.com:2222".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let second = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 2222,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        assert_ne!(connection_key(&first), connection_key(&second));

        let third = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice:bob".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let fourth = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("bob:secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        assert_ne!(connection_key(&third), connection_key(&fourth));
    }

    #[test]
    fn connection_key_distinguishes_jump_host_fields_with_colons() {
        // A structured jump-host key must not collide when user-controlled
        // strings contain delimiters that would have merged fields in the old
        // format-string key.
        let first = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "a".to_string(),
                port: 1,
                username: "1:b".to_string(),
                auth_method: AuthMethod::Password,
                password: None,
                keychain_key_id: None,

                private_key_data: None,
                passphrase: None,
            }),
        };
        let second = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "a:1".to_string(),
                port: 1,
                username: "b".to_string(),
                auth_method: AuthMethod::Password,
                password: None,
                keychain_key_id: None,

                private_key_data: None,
                passphrase: None,
            }),
        };

        assert_ne!(connection_key(&first), connection_key(&second));
    }
