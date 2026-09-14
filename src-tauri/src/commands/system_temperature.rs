//! Read-only ASUS ATK sensor access through the already installed COM service.
//! Never accesses raw registers or invokes fan/voltage/firmware setters.
use windows::core::{w, GUID, PCWSTR};
use windows::Win32::System::Com::{
    CLSIDFromProgID, CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch,
    CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, DISPATCH_FLAGS, DISPATCH_METHOD,
    DISPATCH_PROPERTYGET, DISPPARAMS,
};
use windows::Win32::System::Variant::{VARIANT, VT_BSTR, VT_BYREF, VT_UI4};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: paired with this thread's successful CoInitializeEx.
        unsafe { CoUninitialize() };
    }
}

fn invoke(
    object: &IDispatch,
    name: &str,
    flags: DISPATCH_FLAGS,
    args: &mut [VARIANT],
) -> Option<VARIANT> {
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut id = 0;
    let mut result = VARIANT::default();
    let params = DISPPARAMS {
        rgvarg: args.as_mut_ptr(),
        cArgs: args.len() as u32,
        ..Default::default()
    };
    // SAFETY: valid NUL-terminated name, initialized variants and live COM
    // interfaces; arguments are in COM's reverse order. VARIANT owns results.
    unsafe {
        object
            .GetIDsOfNames(&GUID::zeroed(), &PCWSTR(name.as_ptr()), 1, 0, &mut id)
            .ok()?;
        object
            .Invoke(
                id,
                &GUID::zeroed(),
                0,
                flags,
                &params,
                Some(&mut result),
                None,
                None,
            )
            .ok()?;
    }
    Some(result)
}

pub(super) fn cpu_temperature() -> Option<f32> {
    // COM interfaces stay on this worker thread and drop before its apartment.
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()? };
    let _apartment = Apartment;
    let clsid = unsafe { CLSIDFromProgID(w!("atkexCom.axdata")).ok()? };
    let service: IDispatch = unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER).ok()? };
    let collection = invoke(
        &service,
        "ItemsOfGroup",
        DISPATCH_METHOD,
        &mut [VARIANT::from(6u32)],
    )?;
    let collection = IDispatch::try_from(&collection).ok()?;
    let count = invoke(&collection, "Count", DISPATCH_PROPERTYGET, &mut [])?;
    let count = i32::try_from(&count).ok()?;
    if !(1..=256).contains(&count) {
        return None;
    }
    let mut cpu = None;
    let mut package = None;
    for index in 0..count {
        let item = invoke(
            &collection,
            "Item",
            DISPATCH_PROPERTYGET,
            &mut [VARIANT::from(index)],
        )?;
        let item = IDispatch::try_from(&item).ok()?;
        let name = invoke(&item, "name", DISPATCH_PROPERTYGET, &mut [])?;
        if name.vt() != VT_BSTR {
            continue;
        }
        // SAFETY: VT_BSTR was checked and the owning result stays live here.
        let name =
            unsafe { name.Anonymous.Anonymous.Anonymous.bstrVal.to_string() }.to_ascii_lowercase();
        if !matches!(name.as_str(), "cpu" | "cpu package") {
            continue;
        }
        let id = invoke(&item, "id", DISPATCH_PROPERTYGET, &mut [])?;
        let id = u32::try_from(&id).ok()?;
        // ATK class 6, temperature type 3. A label alone cannot prove units.
        if id & 0xffff0000 != 0x06030000 {
            continue;
        }
        let mut raw = 0u32;
        let mut output = VARIANT::default();
        // SAFETY: VT_UI4|VT_BYREF points to raw until synchronous Invoke ends;
        // VariantClear does not free the caller-owned by-reference value.
        unsafe {
            (*output.Anonymous.Anonymous).vt = VT_UI4 | VT_BYREF;
            (*output.Anonymous.Anonymous).Anonymous.pulVal = &mut raw;
        }
        let status = invoke(
            &service,
            "iAcpiGetItem",
            DISPATCH_METHOD,
            &mut [output, VARIANT::from(id)],
        )?;
        if u32::try_from(&status).ok()? != 1 {
            continue;
        }
        // ATK temperature values are tenths of a degree Celsius.
        let value = raw as f32 / 10.0;
        if !(0.0..130.0).contains(&value) || value == 0.0 {
            continue;
        }
        if name == "cpu package" {
            package = Some(value);
        } else {
            cpu = Some(value);
        }
    }
    package.or(cpu)
}
