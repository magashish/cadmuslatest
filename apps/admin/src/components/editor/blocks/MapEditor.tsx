import type { MapBlock } from "@cadmus/shared";

const VARIANTS: MapBlock["variant"][] = ["default", "with-info", "full-width"];

interface Props {
  data: MapBlock["data"];
  variant: MapBlock["variant"];
  onDataChange: (data: MapBlock["data"]) => void;
  onVariantChange: (variant: MapBlock["variant"]) => void;
}

export function MapEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  return (
    <div>
      <div className="form-group">
        <label>Variant</label>
        <div className="variant-picker-inline">
          {VARIANTS.map((v) => (
            <button
              key={v}
              type="button"
              className={`variant-chip${variant === v ? " active" : ""}`}
              onClick={() => onVariantChange(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="form-group">
        <label>Address</label>
        <input
          type="text"
          value={data.address}
          onChange={(e) => onDataChange({ ...data, address: e.target.value })}
          placeholder="123 Main St, City, State"
        />
      </div>
      <div className="form-group">
        <label>Latitude</label>
        <input
          type="number"
          step="any"
          value={data.lat ?? ""}
          onChange={(e) => onDataChange({ ...data, lat: e.target.value ? parseFloat(e.target.value) : undefined })}
          placeholder="40.7128"
        />
      </div>
      <div className="form-group">
        <label>Longitude</label>
        <input
          type="number"
          step="any"
          value={data.lng ?? ""}
          onChange={(e) => onDataChange({ ...data, lng: e.target.value ? parseFloat(e.target.value) : undefined })}
          placeholder="-74.0060"
        />
      </div>
      <div className="form-group">
        <label>Zoom Level</label>
        <input
          type="number"
          min={1}
          max={20}
          value={data.zoom ?? 14}
          onChange={(e) => onDataChange({ ...data, zoom: parseInt(e.target.value) || 14 })}
        />
      </div>
      <div className="form-group">
        <label>Business Name</label>
        <input
          type="text"
          value={data.businessName ?? ""}
          onChange={(e) => onDataChange({ ...data, businessName: e.target.value })}
          placeholder="My Business"
        />
      </div>
      <div className="form-group">
        <label>Phone</label>
        <input
          type="text"
          value={data.phone ?? ""}
          onChange={(e) => onDataChange({ ...data, phone: e.target.value })}
          placeholder="(555) 123-4567"
        />
      </div>
      <div className="form-group">
        <label>Hours</label>
        <input
          type="text"
          value={data.hours ?? ""}
          onChange={(e) => onDataChange({ ...data, hours: e.target.value })}
          placeholder="Mon-Fri 9am-5pm"
        />
      </div>
    </div>
  );
}
