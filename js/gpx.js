/**
 * gpx.js
 * Export des parcours au format GPX, TCX et FIT.
 * - GPX et TCX : XML standard, compatible Garmin/Wahoo/Coros/Bryton/Hammerhead.
 * - FIT : encodeur binaire minimal du protocole Garmin FIT (fichier "course"),
 *   suffisant pour être importé comme parcours sur la plupart des compteurs
 *   modernes (Garmin Edge, Wahoo ELEMNT, Coros Dura, Bryton Rider, Hammerhead Karoo).
 *
 * Le format FIT complet est très riche ; cet encodeur se limite aux messages
 * indispensables à un fichier "course" valide : file_id, course, lap, record.
 */

const RPExport = (() => {

  const FIT_EPOCH_OFFSET = 631065600; // secondes entre 1970-01-01 et 1989-12-31 (epoch FIT)

  function nowStamp() {
    return new Date().toISOString();
  }

  function sanitizeFilename(name) {
    return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '') || 'parcours';
  }

  function triggerDownload(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ======================================================================
     GPX
     ====================================================================== */

  function buildGPX(route, name) {
    const points = route.latlngs;
    const coordsWithEle = route.raw?.geometry?.coordinates || null;

    const trkpts = points.map((p, i) => {
      const ele = coordsWithEle?.[i]?.[2];
      return `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${ele != null ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<gpx version="1.1" creator="RoadPlanner" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${nowStamp()}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <type>cycling</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  }

  function exportGPX(route, name) {
    const xml = buildGPX(route, name);
    triggerDownload(`${sanitizeFilename(name)}.gpx`, new Blob([xml], { type: 'application/gpx+xml' }));
  }

  /* ======================================================================
     TCX
     ====================================================================== */

  function buildTCX(route, name) {
    const points = route.latlngs;
    const coordsWithEle = route.raw?.geometry?.coordinates || null;
    const totalDistance = route.distance || 0;
    const totalTime = route.duration || 0;

    let cumulativeDist = 0;
    const trackpoints = points.map((p, i) => {
      if (i > 0) {
        cumulativeDist += RPUtils.haversineDistance(points[i - 1], p);
      }
      const ele = coordsWithEle?.[i]?.[2];
      return `        <Trackpoint>
          <Position>
            <LatitudeDegrees>${p[0].toFixed(6)}</LatitudeDegrees>
            <LongitudeDegrees>${p[1].toFixed(6)}</LongitudeDegrees>
          </Position>
          ${ele != null ? `<AltitudeMeters>${ele.toFixed(1)}</AltitudeMeters>` : ''}
          <DistanceMeters>${cumulativeDist.toFixed(1)}</DistanceMeters>
        </Trackpoint>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Courses>
    <Course>
      <Name>${escapeXml(name)}</Name>
      <Lap>
        <TotalTimeSeconds>${Math.round(totalTime)}</TotalTimeSeconds>
        <DistanceMeters>${totalDistance.toFixed(1)}</DistanceMeters>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
${trackpoints}
      </Track>
    </Course>
  </Courses>
</TrainingCenterDatabase>`;
  }

  function exportTCX(route, name) {
    const xml = buildTCX(route, name);
    triggerDownload(`${sanitizeFilename(name)}.tcx`, new Blob([xml], { type: 'application/vnd.garmin.tcx+xml' }));
  }

  /* ======================================================================
     FIT (encodeur binaire minimal — messages file_id, course, lap, record)
     ====================================================================== */

  const CRC_TABLE = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
  ];

  function crc16Update(crc, byte) {
    let tmp = CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xF];
    tmp = CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF];
    return crc & 0xFFFF;
  }

  function crc16Buffer(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i += 1) crc = crc16Update(crc, bytes[i]);
    return crc;
  }

  /** Petit assembleur binaire séquentiel (little-endian, comme l'exige FIT). */
  class ByteWriter {
    constructor() { this.chunks = []; }
    u8(v) { this.chunks.push(new Uint8Array([v & 0xFF])); }
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.chunks.push(b); }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.chunks.push(b); }
    i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.chunks.push(b); }
    bytes(arr) { this.chunks.push(new Uint8Array(arr)); }
    str(s, len) {
      const b = new Uint8Array(len);
      const enc = new TextEncoder().encode(s).slice(0, len - 1);
      b.set(enc);
      this.chunks.push(b);
    }
    toUint8Array() {
      const total = this.chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      this.chunks.forEach((c) => { out.set(c, offset); offset += c.length; });
      return out;
    }
  }

  const degToSemicircles = (deg) => Math.round(deg * (Math.pow(2, 31) / 180));

  /** Message de définition FIT générique. */
  function defMessage(localType, globalMesgNum, fields) {
    const w = new ByteWriter();
    w.u8(0x40 | localType); // header : bit6=1 (définition), local type
    w.u8(0); // reserved
    w.u8(0); // architecture : 0 = little endian
    w.u16(globalMesgNum);
    w.u8(fields.length);
    fields.forEach((f) => { w.u8(f.num); w.u8(f.size); w.u8(f.baseType); });
    return w.toUint8Array();
  }

  /**
   * Construit un fichier FIT "course" minimal à partir d'un parcours normalisé.
   * Compatible avec l'import "parcours"/"course" sur la plupart des compteurs
   * Garmin, Wahoo, Coros, Bryton et Hammerhead (spécification FIT SDK Garmin).
   */
  function buildFIT(route, name) {
    const points = route.latlngs;
    const coordsWithEle = route.raw?.geometry?.coordinates || null;
    const nowFit = Math.floor(Date.now() / 1000) - FIT_EPOCH_OFFSET;

    const body = new ByteWriter();

    // ---- file_id (global 0), local type 0 ----
    body.bytes(defMessage(0, 0, [
      { num: 0, size: 1, baseType: 0x00 }, // type (enum)
      { num: 1, size: 2, baseType: 0x84 }, // manufacturer (uint16)
      { num: 2, size: 2, baseType: 0x84 }, // product (uint16)
      { num: 4, size: 4, baseType: 0x86 }, // time_created (uint32)
    ]));
    body.u8(0x00); // data record header, local type 0
    body.u8(6);    // type = course
    body.u16(255); // manufacturer = development
    body.u16(0);   // product
    body.u32(nowFit);

    // ---- course (global 31), local type 1 ----
    body.bytes(defMessage(1, 31, [
      { num: 5, size: 16, baseType: 0x07 }, // name (string, 16 octets)
    ]));
    body.u8(0x01);
    body.str(name, 16);

    // ---- lap (global 19), local type 2 ----
    const totalDistanceCm = Math.round((route.distance || 0) * 100);
    const totalTimeMs = Math.round((route.duration || 0) * 1000);
    body.bytes(defMessage(2, 19, [
      { num: 253, size: 4, baseType: 0x86 }, // timestamp
      { num: 2, size: 4, baseType: 0x86 },   // start_time
      { num: 3, size: 4, baseType: 0x85 },   // start_position_lat (sint32)
      { num: 4, size: 4, baseType: 0x85 },   // start_position_long
      { num: 5, size: 4, baseType: 0x85 },   // end_position_lat
      { num: 6, size: 4, baseType: 0x85 },   // end_position_long
      { num: 7, size: 4, baseType: 0x86 },   // total_elapsed_time (uint32, *1000)
      { num: 9, size: 4, baseType: 0x86 },   // total_distance (uint32, *100)
    ]));
    body.u8(0x02);
    body.u32(nowFit);
    body.u32(nowFit);
    body.i32(degToSemicircles(points[0][0]));
    body.i32(degToSemicircles(points[0][1]));
    body.i32(degToSemicircles(points[points.length - 1][0]));
    body.i32(degToSemicircles(points[points.length - 1][1]));
    body.u32(totalTimeMs);
    body.u32(totalDistanceCm);

    // ---- record (global 20), local type 3, un message par point ----
    body.bytes(defMessage(3, 20, [
      { num: 253, size: 4, baseType: 0x86 }, // timestamp
      { num: 0, size: 4, baseType: 0x85 },   // position_lat
      { num: 1, size: 4, baseType: 0x85 },   // position_long
      { num: 2, size: 2, baseType: 0x84 },   // altitude (uint16, scale 5, offset 500)
      { num: 5, size: 4, baseType: 0x86 },   // distance (uint32, *100)
    ]));

    let cumulativeDist = 0;
    const avgSpeedMs = ((route.distance || 1) / Math.max(1, route.duration || 1));
    points.forEach((p, i) => {
      if (i > 0) cumulativeDist += RPUtils.haversineDistance(points[i - 1], p);
      const ele = coordsWithEle?.[i]?.[2] ?? 0;
      const altEncoded = Math.round((ele + 500) * 5);
      const tStamp = nowFit + Math.round(cumulativeDist / Math.max(0.1, avgSpeedMs));
      body.u8(0x03);
      body.u32(tStamp);
      body.i32(degToSemicircles(p[0]));
      body.i32(degToSemicircles(p[1]));
      body.u16(Math.max(0, Math.min(65534, altEncoded)));
      body.u32(Math.round(cumulativeDist * 100));
    });

    const bodyBytes = body.toUint8Array();

    // ---- en-tête FIT (12 octets, sans CRC d'en-tête) ----
    const header = new ByteWriter();
    header.u8(12);            // taille de l'en-tête
    header.u8(0x20);          // version protocole (2.0)
    header.u16(2167);         // version profil
    header.u32(bodyBytes.length);
    header.bytes([0x2E, 0x46, 0x49, 0x54]); // ".FIT"
    const headerBytes = header.toUint8Array();

    // ---- CRC final sur en-tête + corps ----
    const withoutCrc = new Uint8Array(headerBytes.length + bodyBytes.length);
    withoutCrc.set(headerBytes, 0);
    withoutCrc.set(bodyBytes, headerBytes.length);
    const crc = crc16Buffer(withoutCrc);

    const final = new Uint8Array(withoutCrc.length + 2);
    final.set(withoutCrc, 0);
    new DataView(final.buffer).setUint16(withoutCrc.length, crc, true);

    return final;
  }

  function exportFIT(route, name) {
    try {
      const bytes = buildFIT(route, name);
      triggerDownload(`${sanitizeFilename(name)}.fit`, new Blob([bytes], { type: 'application/octet-stream' }));
    } catch (err) {
      console.error('Erreur génération FIT', err);
      RPUtils.toast('Export FIT indisponible pour ce parcours, essayez GPX ou TCX.', { error: true });
    }
  }

  function escapeXml(str) {
    return String(str).replace(/[<>&'"]/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
    }[c]));
  }

  return { exportGPX, exportTCX, exportFIT };
})();
