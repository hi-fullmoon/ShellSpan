// File DELETE is granted only on ordinary objects; DELETE_CHILD is never granted.
// All ancestors of frozen secrets must be pinned against directory rename/delete.
pub const READ: u32 = 0x0012_0089;
pub const EXECUTE: u32 = 0x0012_00a9;
pub const WRITE: u32 = 0x0012_0116;
pub const DELETE: u32 = 0x0001_0000;
pub const DELETE_CHILD: u32 = 0x40;
pub const CHANGE_ACL: u32 = 0x000c_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Object {
    OrdinaryFile,
    OrdinaryDirectory,
    PinnedDirectory,
    Secret,
    RootEnvLocal,
    Rules,
    External,
}
pub fn access(workspace: bool, object: Object) -> u32 {
    match object {
        Object::Secret | Object::External => 0,
        Object::RootEnvLocal | Object::Rules => READ,
        Object::OrdinaryFile if workspace => READ | WRITE | DELETE,
        Object::OrdinaryDirectory if workspace => EXECUTE | WRITE | DELETE,
        Object::PinnedDirectory if workspace => EXECUTE | WRITE,
        Object::OrdinaryDirectory | Object::PinnedDirectory => EXECUTE,
        Object::OrdinaryFile => READ,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rights_preserve_sensitive_objects_and_ancestors() {
        for workspace in [false, true] {
            for object in [
                Object::OrdinaryFile,
                Object::OrdinaryDirectory,
                Object::PinnedDirectory,
                Object::Secret,
                Object::RootEnvLocal,
                Object::Rules,
                Object::External,
            ] {
                assert_eq!(access(workspace, object) & (DELETE_CHILD | CHANGE_ACL), 0);
            }
            assert_eq!(access(workspace, Object::Secret), 0);
            assert_eq!(access(workspace, Object::External), 0);
            assert_eq!(
                access(workspace, Object::RootEnvLocal) & (0x116 | DELETE),
                0
            );
            assert_eq!(access(false, Object::OrdinaryFile) & (0x116 | DELETE), 0);
            assert_eq!(access(workspace, Object::PinnedDirectory) & DELETE, 0);
        }
        assert_ne!(access(true, Object::OrdinaryFile) & DELETE, 0);
        assert_eq!(access(false, Object::OrdinaryFile) & DELETE, 0);
    }
}
