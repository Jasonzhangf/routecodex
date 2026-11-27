use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
    FILE_OPEN_IF, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    RtlNtStatusToDosError, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, SetFileInformationByHandle, DELETE, FILE_DISPOSITION_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, SYNCHRONIZE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const SHARE_RW: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;
const SHARE_ALL: u32 = SHARE_RW | FILE_SHARE_DELETE;

pub(super) fn open_parent(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(FILE_TRAVERSE | SYNCHRONIZE)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

pub(super) fn open_dir(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
    open_relative(
        parent,
        name,
        FILE_TRAVERSE,
        SHARE_ALL,
        if create { FILE_OPEN_IF } else { FILE_OPEN },
        FILE_DIRECTORY_FILE,
    )
}

pub(super) fn open_file(parent: &File, name: &OsStr) -> io::Result<File> {
    open_relative(
        parent,
        name,
        FILE_GENERIC_READ,
        SHARE_ALL,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
    )
}

pub(super) fn create_file(parent: &File, name: &OsStr) -> io::Result<File> {
    open_relative(
        parent,
        name,
        FILE_GENERIC_WRITE,
        SHARE_ALL,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE,
    )
}

pub(super) fn open_lock(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
    let (access, disposition) = if create {
        (FILE_GENERIC_READ | FILE_GENERIC_WRITE, FILE_OPEN_IF)
    } else {
        (FILE_GENERIC_READ, FILE_OPEN)
    };
    open_relative(
        parent,
        name,
        access,
        SHARE_RW,
        disposition,
        FILE_NON_DIRECTORY_FILE,
    )
}

pub(super) fn remove_file(parent: &File, name: &OsStr) -> io::Result<()> {
    remove(parent, name, FILE_NON_DIRECTORY_FILE)
}

pub(super) fn remove_dir(parent: &File, name: &OsStr) -> io::Result<()> {
    remove(parent, name, FILE_DIRECTORY_FILE)
}

fn remove(parent: &File, name: &OsStr, kind: u32) -> io::Result<()> {
    let file = open_relative(parent, name, DELETE, SHARE_ALL, FILE_OPEN, kind)?;
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // The handle was opened for DELETE. The buffer is the structure required by
    // FileDispositionInfo and stays valid for the duration of the call.
    let success = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&raw const disposition).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    // FileDispositionInfo completes deletion when this handle closes.
    drop(file);
    Ok(())
}

fn open_relative(
    parent: &File,
    name: &OsStr,
    access: u32,
    share: u32,
    disposition: u32,
    kind: u32,
) -> io::Result<File> {
    // The address supplies either a canonical basename or one bounded literal
    // component. Pass it as a counted string rooted at the open directory.
    let mut buffer: Vec<u16> = name.encode_wide().collect();
    let size = (buffer.len() * size_of::<u16>()) as u16;
    let name = UNICODE_STRING {
        Length: size,
        MaximumLength: size,
        Buffer: buffer.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut file = null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    // The parent handle and all input buffers remain live. Both outputs are
    // writable and the file is opened for synchronous I/O.
    let status = unsafe {
        NtCreateFile(
            &mut file,
            access | SYNCHRONIZE,
            &attributes,
            &mut status_block,
            null(),
            0,
            share,
            disposition,
            kind | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status < 0 {
        // RtlNtStatusToDosError accepts this failed NTSTATUS by value.
        let error = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    // A successful NtCreateFile returns a new handle. Transfer sole ownership
    // to File so it closes on every exit path.
    Ok(unsafe { File::from_raw_handle(file) })
}
