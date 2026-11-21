//! Current-token private object ownership and protected access control.
use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::{offset_of, size_of},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::null_mut,
};

use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, GENERIC_ALL, GENERIC_WRITE, HANDLE, LocalFree},
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SetSecurityInfo,
        },
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
        GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, GetTokenInformation,
        INHERIT_ONLY_ACE, IsValidAcl, IsValidSid, IsWellKnownSid, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    },
    Storage::FileSystem::{
        DELETE, FILE_ALL_ACCESS, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CREATE_NEW, CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        },
    };

    #[test]
    fn private_modes_reject_a_broad_or_inherited_dacl_and_restore_the_held_file() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("owned.bin");
        let path: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
        let initial = PrivateSecurity::for_mode(0o600).unwrap();
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | WRITE_DAC,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &initial.attributes(false),
                CREATE_NEW,
                0,
                null_mut(),
            )
        };
        assert!(!handle.is_null() && handle != INVALID_HANDLE_VALUE);
        let file = unsafe { File::from_raw_handle(handle.cast()) };
        PrivateSecurity::for_mode(0o400)
            .unwrap()
            .apply_to(&file)
            .unwrap();
        assert!(PrivateSecurity::matches(&file, Some(0o400)).unwrap());

        // Deliberately broaden only this synthetic file; retain its owner and
        // held identity so the check proves that the DACL itself is rejected.
        let broad: Vec<_> = "D:P(A;;FA;;;WD)".encode_utf16().chain([0]).collect();
        let mut descriptor = null_mut();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                broad.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        })
        .unwrap();
        let descriptor = LocalAllocation(descriptor);
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        checked(unsafe {
            GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted)
        })
        .unwrap();
        assert_ne!(present, 0);
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    file.as_raw_handle().cast(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null_mut(),
                )
            },
            0
        );
        assert!(!PrivateSecurity::matches(&file, Some(0o400)).unwrap());
        assert!(PrivateSecurity::matches(&file, None).unwrap());
        PrivateSecurity::for_mode(0o400)
            .unwrap()
            .apply_to(&file)
            .unwrap();
        assert!(PrivateSecurity::matches(&file, Some(0o400)).unwrap());

        let current = PrivateSecurity::for_mode(0o400).unwrap();
        checked(unsafe {
            GetSecurityDescriptorDacl(current.pointer(), &mut present, &mut dacl, &mut defaulted)
        })
        .unwrap();
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    file.as_raw_handle().cast(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION
                        | windows_sys::Win32::Security::UNPROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null_mut(),
                )
            },
            0
        );
        assert!(!PrivateSecurity::matches(&file, Some(0o400)).unwrap());
        current.apply_to(&file).unwrap();
        assert!(PrivateSecurity::matches(&file, Some(0o400)).unwrap());
    }
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid private security descriptor",
    )
}

fn checked(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn mode_rights(mode: u32) -> io::Result<u32> {
    match mode {
        0o700 => Ok(FILE_ALL_ACCESS),
        0o600 => Ok(FILE_GENERIC_READ | FILE_GENERIC_WRITE),
        0o500 => Ok(FILE_GENERIC_READ | FILE_GENERIC_EXECUTE),
        0o400 => Ok(FILE_GENERIC_READ),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsupported private mode",
        )),
    }
}

fn allow_sid(ace: *mut c_void, size: usize) -> Option<PSID> {
    const SID_OFFSET: usize = offset_of!(ACCESS_ALLOWED_ACE, SidStart);
    if size < SID_OFFSET + 8 {
        return None;
    }
    let sid: PSID = unsafe { ace.cast::<u8>().add(SID_OFFSET).cast() };
    // The ACE bounds are validated before access. Check the variable-length
    // SID before passing the pointer to a Win32 SID function.
    let count = unsafe { *sid.cast::<u8>().add(1) } as usize;
    if count > 15 || SID_OFFSET + 8 + count * 4 != size || unsafe { IsValidSid(sid) } == 0 {
        return None;
    }
    Some(sid)
}

struct FileSecurity {
    descriptor: LocalAllocation,
    owner: PSID,
    dacl: *mut ACL,
}

impl FileSecurity {
    fn read(file: &File) -> io::Result<Self> {
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        // The result owns the storage containing the owner SID and DACL.
        let code = unsafe {
            GetSecurityInfo(
                file.as_raw_handle().cast(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        Ok(Self {
            descriptor: LocalAllocation(descriptor),
            owner,
            dacl,
        })
    }

    fn owned_by(&self, expected: PSID) -> bool {
        !self.owner.is_null()
            && unsafe { IsValidSid(self.owner) } != 0
            && unsafe { EqualSid(self.owner, expected) } != 0
    }
}

/// One explicit current-user owner and one non-inheriting, protected allow ACE.
pub(crate) struct PrivateSecurity(LocalAllocation);
impl PrivateSecurity {
    pub(crate) fn new() -> io::Result<Self> {
        Self::with_rights(GENERIC_ALL)
    }

    pub(crate) fn for_mode(mode: u32) -> io::Result<Self> {
        Self::with_rights(mode_rights(mode)?)
    }

    fn with_rights(rights: u32) -> io::Result<Self> {
        let mut token: HANDLE = null_mut();
        checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        let token = unsafe { OwnedHandle::from_raw_handle(token.cast()) };
        let mut needed = 0;
        let initial = unsafe {
            GetTokenInformation(
                token.as_raw_handle().cast(),
                TokenUser,
                null_mut(),
                0,
                &mut needed,
            )
        };
        if initial != 0
            || io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
            || needed < size_of::<TOKEN_USER>() as u32
            || needed > 1024 * 1024
        {
            return Err(invalid());
        }
        let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        checked(unsafe {
            GetTokenInformation(
                token.as_raw_handle().cast(),
                TokenUser,
                storage.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        })?;
        let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
        let mut sid = null_mut();
        checked(unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) })?;
        let sid_memory = LocalAllocation(sid.cast());
        // The API returns a NUL-terminated SID string with at most 15 subauthorities.
        let length = (0..256)
            .find(|index| unsafe { *sid.add(*index) == 0 })
            .ok_or_else(invalid)?;
        let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, length) })
            .map_err(|_| invalid())?;
        drop(sid_memory);
        let descriptor: Vec<_> = format!("O:{sid}D:P(A;;0x{rights:08x};;;{sid})")
            .encode_utf16()
            .chain([0])
            .collect();
        let mut security = null_mut();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                SDDL_REVISION_1,
                &mut security,
                null_mut(),
            )
        })?;
        Ok(Self(LocalAllocation(security)))
    }

    pub(crate) fn pointer(&self) -> *mut c_void {
        self.0.0
    }

    pub(crate) fn attributes(&self, inherit: bool) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.pointer(),
            bInheritHandle: i32::from(inherit),
        }
    }

    fn owner(&self) -> io::Result<PSID> {
        let mut owner = null_mut();
        let mut defaulted = 0;
        checked(unsafe { GetSecurityDescriptorOwner(self.pointer(), &mut owner, &mut defaulted) })?;
        if owner.is_null() || unsafe { IsValidSid(owner) } == 0 {
            return Err(invalid());
        }
        Ok(owner)
    }

    pub(crate) fn matches(file: &File, mode: Option<u32>) -> io::Result<bool> {
        let expected =
            Self::with_rights(mode.map(mode_rights).transpose()?.unwrap_or(GENERIC_ALL))?;
        let security = FileSecurity::read(file)?;
        let dacl = security.dacl;
        let expected_owner = expected.owner()?;
        if !security.owned_by(expected_owner) {
            return Ok(false);
        }
        let Some(mode) = mode else {
            return Ok(true);
        };
        let mut control = 0;
        let mut revision = 0;
        checked(unsafe {
            GetSecurityDescriptorControl(security.descriptor.0, &mut control, &mut revision)
        })?;
        if control & SE_DACL_PROTECTED == 0
            || dacl.is_null()
            || unsafe { IsValidAcl(dacl) } == 0
            || unsafe { (*dacl).AceCount } != 1
        {
            return Ok(false);
        }
        let mut ace = null_mut();
        checked(unsafe { GetAce(dacl, 0, &mut ace) })?;
        let start = dacl as usize;
        let end = start
            .checked_add(unsafe { (*dacl).AclSize } as usize)
            .ok_or_else(invalid)?;
        let address = ace as usize;
        const SID_OFFSET: usize = offset_of!(ACCESS_ALLOWED_ACE, SidStart);
        if address < start + size_of::<ACL>()
            || address
                .checked_add(SID_OFFSET + 8)
                .is_none_or(|value| value > end)
        {
            return Ok(false);
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let ace_end = address
            .checked_add(allowed.Header.AceSize as usize)
            .ok_or_else(invalid)?;
        if allowed.Header.AceType != 0
            || allowed.Header.AceFlags != 0
            || allowed.Mask != mode_rights(mode)?
            || ace_end > end
            || (allowed.Header.AceSize as usize) < SID_OFFSET + 8
        {
            return Ok(false);
        }
        Ok(allow_sid(ace, usize::from(allowed.Header.AceSize))
            .is_some_and(|sid| unsafe { EqualSid(sid, expected_owner) } != 0))
    }

    /// Accept the current user's existing app-data directory with its usual
    /// inherited ACL. The new Store namespace still requires the exact ACL.
    pub(crate) fn store_anchor(file: &File) -> io::Result<bool> {
        let expected = Self::new()?;
        let expected_owner = expected.owner()?;
        let security = FileSecurity::read(file)?;
        let dacl = security.dacl;
        if !security.owned_by(expected_owner) || dacl.is_null() || unsafe { IsValidAcl(dacl) } == 0
        {
            return Ok(false);
        }
        const MUTATION: u32 = GENERIC_ALL
            | GENERIC_WRITE
            | DELETE
            | WRITE_DAC
            | WRITE_OWNER
            | FILE_DELETE_CHILD
            | (FILE_GENERIC_WRITE & !(SYNCHRONIZE | READ_CONTROL));
        // Validate the entire kernel ACL before inspecting basic ACEs.
        let count = unsafe { (*dacl).AceCount };
        for index in 0..u32::from(count) {
            let mut ace = null_mut();
            checked(unsafe { GetAce(dacl, index, &mut ace) })?;
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 || header.AceType == 1 {
                continue;
            }
            if header.AceType != 0
                || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>() + 4
            {
                return Ok(false);
            }
            let allow = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            if allow.Mask & MUTATION == 0 {
                continue;
            }
            let Some(sid) = allow_sid(ace, usize::from(header.AceSize)) else {
                return Ok(false);
            };
            if unsafe { EqualSid(sid, expected_owner) } == 0
                && unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } == 0
                && unsafe { IsWellKnownSid(sid, WinBuiltinAdministratorsSid) } == 0
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(crate) fn apply_to(&self, file: &File) -> io::Result<()> {
        if !Self::matches(file, None)? {
            return Err(invalid());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        checked(unsafe {
            GetSecurityDescriptorDacl(self.pointer(), &mut present, &mut dacl, &mut defaulted)
        })?;
        if present == 0 || dacl.is_null() {
            return Err(invalid());
        }
        // Reopen the same held object for ACL access, never a new path binding.
        // Owners can tighten their DACL without requesting WRITE_OWNER.
        let handle = crate::filesystem::reopen_held(file, WRITE_DAC | READ_CONTROL)?;
        let code = unsafe {
            SetSecurityInfo(
                handle.as_raw_handle().cast(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            )
        };
        if code == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(code as i32))
        }
    }
}
