import json

path = "local_sheets_db.json"
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

emp = data.get("employee", [])
if len(emp) > 1:
    headers = [str(h).strip().lower() for h in emp[0]]
    pos_idx = headers.index("position") if "position" in headers else 1
    upline_idx = headers.index("upline") if "upline" in headers else 3

    for row in emp[1:]:
        if len(row) > max(pos_idx, upline_idx):
            pos_val = str(row[pos_idx]).lower()
            if "sales agronomist" in pos_val:
                row[upline_idx] = "Agus Herdianto"

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("Updated local_sheets_db.json successfully")
