use rustix::fs::{mkdirat, open, openat, unlinkat, AtFlags, Mode, OFlags};
use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::Path;

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const LEAF: OFlags = OFlags::NOFOLLOW
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK);

pub(super) fn open_parent(path: &Path) -> io::Result<File> {
    Ok(open(path, DIRECTORY, Mode::empty())?.into())
}

pub(super) fn open_dir(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
    if create {
        match mkdirat(parent, name, Mode::from_raw_mode(0o777)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(openat(parent, name, DIRECTORY, Mode::empty())?.into())
}

pub(super) fn open_file(parent: &File, name: &OsStr) -> io::Result<File> {
    Ok(openat(parent, name, LEAF | OFlags::RDONLY, Mode::empty())?.into())
}

pub(super) fn create_file(parent: &File, name: &OsStr) -> io::Result<File> {
    Ok(openat(
        parent,
        name,
        LEAF | OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(0o666),
    )?
    .into())
}

pub(super) fn open_lock(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
    if create {
        return Ok(openat(
            parent,
            name,
            LEAF | OFlags::RDWR | OFlags::CREATE,
            Mode::from_raw_mode(0o666),
        )?
        .into());
    }
    open_file(parent, name)
}

pub(super) fn remove_file(parent: &File, name: &OsStr) -> io::Result<()> {
    Ok(unlinkat(parent, name, AtFlags::empty())?)
}

pub(super) fn remove_dir(parent: &File, name: &OsStr) -> io::Result<()> {
    Ok(unlinkat(parent, name, AtFlags::REMOVEDIR)?)
}
