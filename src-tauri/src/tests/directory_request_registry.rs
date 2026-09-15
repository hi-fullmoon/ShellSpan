    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn newer_generation_cancels_previous_and_late_older_is_pre_cancelled() {
        let registry = DirectoryRequestRegistry::default();
        let first = registry.register("tab-1:remote", 1).unwrap();
        let second = registry.register("tab-1:remote", 2).unwrap();

        assert!(first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));

        let late_first = registry.register("tab-1:remote", 1).unwrap();
        assert!(late_first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));
    }

    #[test]
    fn same_generation_shares_the_cancellation_flag() {
        let registry = DirectoryRequestRegistry::default();
        let listing = registry.register("tab-1:remote", 7).unwrap();
        let owners = registry.register("tab-1:remote", 7).unwrap();

        assert!(Arc::ptr_eq(&listing, &owners));
        registry.register("tab-1:remote", 8).unwrap();
        assert!(listing.load(Ordering::SeqCst));
        assert!(owners.load(Ordering::SeqCst));
    }

    #[test]
    fn invalid_request_identity_is_rejected_without_growing_the_registry() {
        let registry = DirectoryRequestRegistry::default();

        assert_eq!(
            registry.register("", 1).unwrap_err(),
            "invalid remote directory request key"
        );
        assert_eq!(
            registry.register("tab-1:remote", 0).unwrap_err(),
            "invalid remote directory request id"
        );
        assert!(registry.generations.lock().unwrap().is_empty());
    }

    #[test]
    fn expired_inactive_generations_are_reclaimed_when_capacity_is_reached() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        for index in 0..MAX_DIRECTORY_REQUEST_KEYS {
            drop(
                registry
                    .register_at(&format!("pane-{index}"), 1, started_at)
                    .unwrap(),
            );
        }

        let fresh = registry
            .register_at(
                "fresh-pane",
                1,
                started_at + DIRECTORY_REQUEST_RETENTION + Duration::from_millis(1),
            )
            .expect("expired inactive watermarks should free capacity");

        let generations = registry.generations.lock().unwrap();
        assert_eq!(generations.len(), 1);
        assert!(generations.contains_key("fresh-pane"));
        assert!(!fresh.load(Ordering::SeqCst));
    }

    #[test]
    fn recent_generations_are_not_reclaimed_for_capacity() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        for index in 0..MAX_DIRECTORY_REQUEST_KEYS {
            drop(
                registry
                    .register_at(&format!("pane-{index}"), 1, started_at)
                    .unwrap(),
            );
        }

        let result = registry.register_at(
            "too-soon",
            1,
            started_at + DIRECTORY_REQUEST_RETENTION - Duration::from_millis(1),
        );

        assert_eq!(
            result.unwrap_err(),
            "remote directory request registry is full"
        );
        assert_eq!(
            registry.generations.lock().unwrap().len(),
            MAX_DIRECTORY_REQUEST_KEYS
        );
    }

    #[test]
    fn expired_but_active_generation_is_never_reclaimed() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        let active = registry.register_at("active-pane", 1, started_at).unwrap();
        for index in 1..MAX_DIRECTORY_REQUEST_KEYS {
            drop(
                registry
                    .register_at(&format!("pane-{index}"), 1, started_at)
                    .unwrap(),
            );
        }

        let fresh = registry
            .register_at(
                "fresh-pane",
                1,
                started_at + DIRECTORY_REQUEST_RETENTION + Duration::from_millis(1),
            )
            .expect("inactive generations should make room around an active one");

        let generations = registry.generations.lock().unwrap();
        assert_eq!(generations.len(), 2);
        assert!(generations.contains_key("active-pane"));
        assert!(generations.contains_key("fresh-pane"));
        assert!(!active.load(Ordering::SeqCst));
        assert!(!fresh.load(Ordering::SeqCst));
    }

    #[test]
    fn registering_the_current_generation_refreshes_its_retention_time() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        let first = registry.register_at("active-pane", 4, started_at).unwrap();
        let refreshed_at = started_at + Duration::from_secs(60);
        let refreshed = registry
            .register_at("active-pane", 4, refreshed_at)
            .unwrap();

        assert!(Arc::ptr_eq(&first, &refreshed));
        assert_eq!(
            registry
                .generations
                .lock()
                .unwrap()
                .get("active-pane")
                .unwrap()
                .last_registered_at,
            refreshed_at
        );
    }

    #[test]
    fn superseded_waiter_skips_network_closure_after_mutex_becomes_available() {
        let registry = DirectoryRequestRegistry::default();
        let old_flag = registry.register("tab-1:remote", 1).unwrap();
        let connection = Arc::new(Mutex::new(()));
        let held_connection = connection.lock().unwrap();
        let network_calls = Arc::new(AtomicUsize::new(0));
        let (waiting_tx, waiting_rx) = mpsc::channel();

        let worker_connection = connection.clone();
        let worker_calls = network_calls.clone();
        let worker = thread::spawn(move || {
            waiting_tx.send(()).unwrap();
            with_connection_lock_if_current(&worker_connection, &old_flag, |_| {
                worker_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });

        waiting_rx.recv().unwrap();
        // Give the worker a chance to enter Mutex::lock while the guard above
        // keeps the connection unavailable.
        thread::sleep(Duration::from_millis(10));
        registry.register("tab-1:remote", 2).unwrap();
        drop(held_connection);

        assert_eq!(
            worker.join().unwrap(),
            Err(RemoteFsError::Other {
                message: DIRECTORY_REQUEST_SUPERSEDED_MESSAGE.to_string(),
            })
        );
        assert_eq!(network_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn current_request_preserves_operation_error() {
        let connection = Mutex::new(());
        let current = AtomicBool::new(false);
        let expected = RemoteFsError::Other {
            message: "permission denied".to_string(),
        };

        let result = with_connection_lock_if_current(&connection, &current, |_| {
            Err::<(), _>(expected.clone())
        });

        assert_eq!(result, Err(expected));
    }
