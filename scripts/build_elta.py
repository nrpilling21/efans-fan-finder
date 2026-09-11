"""Build data/elta.json from Elta's selection program data files.

Usage:
  1. Extract EltaInstaller.exe (it's a 7-Zip SFX) so you have elta/Data/*.dat
     and elta/Resources/Drawings/**/*.txt
  2. python3 scripts/build_elta.py /path/to/extracted/elta

Re-run whenever Elta issue a new version of the selection program.
"""
import csv, glob, io, json, math, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
from nrbf import items  # noqa: E402

SRC = sys.argv[1] if len(sys.argv) > 1 else 'elta'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'elta.json')


def poly(c, q):
    return sum(a * q ** i for i, a in enumerate(c or []))


def norm(model):
    """Normalise a model code for matching: SCP250/4-1AC -> SCP25041AC."""
    return re.sub(r'[^A-Z0-9]', '', (model or '').upper())


def efans_category(fam, name):
    s = (fam + ' ' + name).lower()
    if 'roof' in s:
        return 'Roof Fans'
    if any(k in s for k in ('heat recovery', 'mvhr', 'energy recovery', 'supply & extract')):
        return 'Heat Recovery'
    if 'piv' in s or 'positive input' in s:
        return 'Positive Input Ventilation'
    if 'residential' in s:
        return 'Ventilation Fans'
    if any(k in s for k in ('centrifugal', 'mixed', 'multiflow', 'box', 'inline', 'jetflow', 'contra-rotating')):
        return 'Duct Fans'
    if any(k in s for k in ('axial', 'plate', 'cased', 'bifurcated', 'wall fan', 'marine', 'smoke', 'atex')):
        return 'Axial Fan'
    return None


def num(v):
    try:
        f = float(v)
        return round(f, 2) if not math.isnan(f) else None
    except (TypeError, ValueError):
        return None


def main():
    data = os.path.join(SRC, 'Data')
    ranges, _ = items(os.path.join(data, 'FanRange.dat'))
    fans, _ = items(os.path.join(data, 'FanData.dat'))
    gid = lambda g: (g or {}).get('_a')
    rmap = {}
    for r in ranges:
        rmap.setdefault(gid(r['b']), r)

    # Revit type catalogues: per-model electrical + dimensional specs
    revit = {}
    for f in glob.glob(os.path.join(SRC, 'Resources', 'Drawings', '**', '*.txt'), recursive=True):
        rows = list(csv.reader(io.StringIO(open(f, 'rb').read().decode('utf-16'))))
        heads = [h.split('##')[0] for h in rows[0]]
        for row in rows[1:]:
            revit[row[0].strip()] = dict(zip(heads, row))

    # Group speed/voltage variants by model; keep the full-speed curve
    by_model = {}
    for x in fans:
        by_model.setdefault(x['s'], []).append(x)

    out = []
    for model, rows in by_model.items():
        if model.startswith('X-'):
            continue  # internal/export duplicates
        top = max(rows, key=lambda r: r.get('aq') or 0)
        r = rmap.get(gid(top['y']))
        if not r:
            continue
        qmax = top.get('aq') or 0
        airflow = round(qmax * 3600) if 0 < qmax < 150 else None
        pressure = poly(top['ar'], top['ap']) if airflow else None
        power = poly(top['at'], qmax) if airflow else None
        m = re.search(r'/(\d{1,2})-(\d)', model)
        poles = int(m.group(1)) if m else None
        phase = int(m.group(2)) if m and m.group(2) in '13' else None
        name = r['c']
        motor = 'EC' if re.search(r'EC\b', model.upper()) or ' EC ' in f' {name} ' else 'AC'
        rv = revit.get(model, {})
        if rv.get('Supply Phase') in ('1', '3'):
            phase = int(rv['Supply Phase'])
        if rv.get('Number of Poles', '').isdigit():
            poles = int(rv['Number of Poles'])
        size = top.get('z') or None
        rec = {
            'model': model,
            'key': norm(model),
            'range': name,
            'family': r['d'],
            'category': efans_category(r['d'], name),
            'size_mm': size,
            'poles': poles,
            'phase': phase,
            'motor_type': motor,
            'rpm': round(top['x']) if top.get('x') else None,
            'airflow_m3h': airflow,
            'max_pressure_pa': round(pressure) if pressure and 0 < pressure < 20000 else None,
            'power_kw': round(power, 3) if power and 0 < power < 500 else None,
            'current': not any(v.get('w') for v in rows),
            'url': r.get('ab') or None,
        }
        spec = {
            'voltage': num(rv.get('Voltage')),
            'flc_a': num(rv.get('Full Load Current')),
            'motor_kw': rv.get('Maximum Motor Power Rating') or None,
            'ip': ('IP' + rv['Enclosure Rating']) if rv.get('Enclosure Rating') else None,
            'weight_kg': num(rv.get('Gross Weight')),
            'width_mm': num(rv.get('Overall Width')),
            'height_mm': num(rv.get('Overall Height')),
            'length_mm': num(rv.get('Overall Length')),
        }
        spec = {k: v for k, v in spec.items() if v}
        if spec:
            rec['spec'] = spec
        out.append({k: v for k, v in rec.items() if v is not None})

    out.sort(key=lambda r: (r['range'], r.get('size_mm') or 0, r['model']))
    with open(OUT, 'w') as f:
        json.dump({'source': 'Elta Selection Program', 'models': out}, f, separators=(',', ':'))
    cur = sum(1 for r in out if r['current'])
    print(f'{len(out)} models ({cur} current), {sum(1 for r in out if "airflow_m3h" in r)} with airflow, '
          f'{sum(1 for r in out if "spec" in r)} with Revit specs -> {OUT}')


if __name__ == '__main__':
    main()
