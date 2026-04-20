#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    term_bridge_lib::run();
}
