import { crc32, deflateRawSync } from 'node:zlib'

// Zip bytes written field by field, so a test can say what an archive tool would never write: a name that climbs
// out, a link, a size that lies, two directory records over one block of data, the encrypted flag

export type ZipEntry = {
  // As the central directory records it, written as UTF-8 with the UTF-8 flag set. A folder ends with /
  name: string
  data?: Buffer | string
  // Deflated unless stored is set
  stored?: boolean
  // A Unix mode, which puts the made-by system at Unix and the mode in the high half of the external attributes
  mode?: number
  // The low half of the external attributes, the MS-DOS ones
  dosAttributes?: number
  // OR-ed into the general purpose flags, 1 is the encrypted bit
  flags?: number
  // The uncompressed size both headers declare, in place of the real one
  declaredSize?: number
  // The index of an earlier entry whose local header and data this record points at, written with no data of its own
  sameDataAs?: number
  // The name the local header gives, in place of the central directory's
  localName?: string
}

const UTF8 = 0x800
const UNIX = 3

type Written = { offset: number, method: number, crc: number, compressed: number, size: number, flags: number }

export function makeZip(entries: readonly ZipEntry[], options: { declaredCount?: number } = {}): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  const written: Written[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    let at: Written
    if (entry.sameDataAs !== undefined) {
      at = written[entry.sameDataAs]
    } else {
      const raw = Buffer.from(entry.data ?? '')
      const body = entry.stored ? raw : deflateRawSync(raw)
      const flags = UTF8 | (entry.flags ?? 0)
      at = { offset, method: entry.stored ? 0 : 8, crc: crc32(raw), compressed: body.length, size: entry.declaredSize ?? raw.length, flags }
      const localName = Buffer.from(entry.localName ?? entry.name, 'utf8')
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(at.flags, 6)
      local.writeUInt16LE(at.method, 8)
      local.writeUInt32LE(at.crc, 14)
      local.writeUInt32LE(at.compressed, 18)
      local.writeUInt32LE(at.size, 22)
      local.writeUInt16LE(localName.length, 26)
      locals.push(local, localName, body)
      offset += local.length + localName.length + body.length
    }
    written.push(at)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(entry.mode === undefined ? 20 : (UNIX << 8) | 20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(at.flags, 8)
    record.writeUInt16LE(at.method, 10)
    record.writeUInt32LE(at.crc, 16)
    record.writeUInt32LE(at.compressed, 20)
    record.writeUInt32LE(at.size, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE((((entry.mode ?? 0) << 16) | (entry.dosAttributes ?? 0)) >>> 0, 38)
    record.writeUInt32LE(at.offset, 42)
    central.push(record, name)
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(options.declaredCount ?? entries.length, 8)
  end.writeUInt16LE(options.declaredCount ?? entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
