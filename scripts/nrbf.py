"""Minimal MS-NRBF (.NET BinaryFormatter) reader for Elta .dat files."""
import struct, sys

class Ref:
    __slots__ = ('id',)
    def __init__(self, i): self.id = i
    def __repr__(self): return f'Ref({self.id})'

class Obj(dict):
    def __init__(self, cls): super().__init__(); self.cls = cls

class R:
    def __init__(self, data, pos=0):
        self.d = data; self.p = pos
        self.objs = {}; self.classes = {}; self.root = None
    def u8(self): v = self.d[self.p]; self.p += 1; return v
    def i32(self): v = struct.unpack_from('<i', self.d, self.p)[0]; self.p += 4; return v
    def unpack(self, fmt):
        v = struct.unpack_from('<' + fmt, self.d, self.p)[0]; self.p += struct.calcsize(fmt); return v
    def string(self):
        n = 0; shift = 0
        while True:
            b = self.u8(); n |= (b & 0x7f) << shift; shift += 7
            if not b & 0x80: break
        s = self.d[self.p:self.p + n].decode('utf-8', 'replace'); self.p += n; return s
    def prim(self, t):
        f = {1: '?', 2: 'B', 6: 'd', 7: 'h', 8: 'i', 9: 'q', 10: 'b', 11: 'f', 12: 'q', 13: 'q',
             14: 'H', 15: 'I', 16: 'Q'}
        if t in f: return self.unpack(f[t])
        if t == 3:  # char utf-8
            b = self.u8(); n = 1 if b < 0x80 else 2 if b < 0xe0 else 3 if b < 0xf0 else 4
            s = bytes([b]) + self.d[self.p:self.p + n - 1]; self.p += n - 1; return s.decode('utf-8', 'replace')
        if t == 5 or t == 18: return self.string()
        raise ValueError(f'prim {t}')

    def classinfo(self):
        oid = self.i32(); name = self.string(); n = self.i32()
        return oid, name, [self.string() for _ in range(n)]
    def memtypes(self, n):
        bts = [self.u8() for _ in range(n)]; add = []
        for bt in bts:
            if bt in (0, 7): add.append(self.u8())
            elif bt == 3: add.append(self.string())
            elif bt == 4: add.append((self.string(), self.i32()))
            else: add.append(None)
        return list(zip(bts, add))

    def read_values(self, obj, names, types):
        for nm, (bt, add) in zip(names, types):
            if bt == 0: obj[nm] = self.prim(add)
            else: obj[nm] = self.record()

    def record(self):
        t = self.u8()
        if t == 0: self.p += 16; return self.record()
        if t == 12: self.i32(); self.string(); return self.record()
        if t == 11: return StopIteration
        if t in (5, 4):
            oid, name, names = self.classinfo(); types = self.memtypes(len(names))
            if t == 5: self.i32()
            self.classes[oid] = (name, names, types)
            o = Obj(name); self.objs[oid] = o; self.read_values(o, names, types); return o
        if t in (3, 2):
            oid, name, names = self.classinfo()
            if t == 3: self.i32()
            self.classes[oid] = (name, names, None)
            raise ValueError('untyped class members not supported')
        if t == 1:
            oid = self.i32(); mid = self.i32(); name, names, types = self.classes[mid]
            self.classes[oid] = (name, names, types)
            o = Obj(name); self.objs[oid] = o; self.read_values(o, names, types); return o
        if t == 6:
            oid = self.i32(); s = self.string(); self.objs[oid] = s; return s
        if t == 8: return self.prim(self.u8())
        if t == 9: return Ref(self.i32())
        if t == 10: return None
        if t in (13, 14):
            n = self.u8() if t == 13 else self.i32(); return ('NULLS', n)
        if t == 15:
            oid = self.i32(); n = self.i32(); pt = self.u8()
            a = [self.prim(pt) for _ in range(n)]; self.objs[oid] = a; return a
        if t in (16, 17):
            oid = self.i32(); n = self.i32(); a = []; self.objs[oid] = a
            self.fill(a, n); return a
        if t == 7:
            oid = self.i32(); atype = self.u8(); rank = self.i32()
            lens = [self.i32() for _ in range(rank)]
            if atype in (3, 4, 5): [self.i32() for _ in range(rank)]
            bt = self.u8(); add = None
            if bt in (0, 7): add = self.u8()
            elif bt == 3: add = self.string()
            elif bt == 4: add = (self.string(), self.i32())
            total = 1
            for l in lens: total *= l
            a = []; self.objs[oid] = a
            if bt == 0: a.extend(self.prim(add) for _ in range(total))
            else: self.fill(a, total)
            return a
        raise ValueError(f'record type {t} at {self.p - 1}')

    def fill(self, a, n):
        while len(a) < n:
            v = self.record()
            if isinstance(v, tuple) and v and v[0] == 'NULLS': a.extend([None] * v[1])
            else: a.append(v)

    def run(self):
        first = None
        while True:
            v = self.record()
            if v is StopIteration: break
            if first is None: first = v
        return first

def resolve(v, objs, seen=None):
    if seen is None: seen = {}
    if isinstance(v, Ref):
        if v.id in seen: return seen[v.id]
        target = objs.get(v.id)
        return resolve(target, objs, seen) if not isinstance(target, Ref) else None
    if isinstance(v, Obj):
        k = id(v)
        if k in seen: return seen[k]
        out = {'__class__': v.cls}; seen[k] = out
        for a, b in v.items(): out[a] = resolve(b, objs, seen)
        return out
    if isinstance(v, list):
        k = id(v)
        if k in seen: return seen[k]
        out = []; seen[k] = out
        out.extend(resolve(x, objs, seen) for x in v); return out
    return v

def load(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'Elta'
    r = R(d, 5)
    root = r.run()
    return resolve(root, r.objs), d[4]

def items(path):
    root, ver = load(path)
    if isinstance(root, dict) and '_items' in root:
        return root['_items'][:root['_size']], ver
    return root, ver

if __name__ == '__main__':
    import json
    it, ver = items(sys.argv[1])
    print('version', ver, 'count', len(it) if isinstance(it, list) else '-')
    for x in (it[:int(sys.argv[2]) if len(sys.argv) > 2 else 2] if isinstance(it, list) else [it]):
        print(json.dumps(x, default=str, indent=1)[:3000])
