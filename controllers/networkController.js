const networkScanner = require('../services/networkScanner');

// Default scan target — local subnet
const DEFAULT_TARGET = '192.168.2.0/24';

exports.getAllDevices = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const devices = await db.collection('network_devices')
      .find({}).sort({ lastSeen: -1 }).toArray();

    res.json({ status: 'success', results: devices.length, data: { devices } });
  } catch (error) { next(error); }
};

exports.scanNetwork = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { target, pruneMissing } = req.body;
    const scanTarget = target || DEFAULT_TARGET;

    // Validate CIDR format to prevent nmap flag injection
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/.test(scanTarget)) {
      return res.status(400).json({ status: 'error', message: 'Invalid target format. Use CIDR notation: x.x.x.x/xx' });
    }

    const discoveredDevices = await networkScanner.scanNetwork(scanTarget);

    const bulkOps = discoveredDevices.map(device => ({
      updateOne: {
        filter: { mac: device.mac },
        update: {
          $set: { ip: device.ip, hostname: device.hostname, vendor: device.vendor, status: 'online', lastSeen: new Date() },
          $setOnInsert: { firstSeen: new Date(), alias: '', notes: '' }
        },
        upsert: true
      }
    }));

    if (bulkOps.length > 0) {
      await db.collection('network_devices').bulkWrite(bulkOps);
    }

    let offlineCount = 0;
    if (pruneMissing === true) {
      const discoveredMacs = new Set(discoveredDevices.map(d => d.mac));
      const allOnline = await db.collection('network_devices').find({ status: 'online' }).toArray();
      const offlineOps = allOnline
        .filter(d => !discoveredMacs.has(d.mac))
        .map(d => ({ updateOne: { filter: { mac: d.mac }, update: { $set: { status: 'offline' } } } }));

      if (offlineOps.length > 0) {
        await db.collection('network_devices').bulkWrite(offlineOps);
        offlineCount = offlineOps.length;
      }
    }

    res.json({
      status: 'success', message: 'Scan completed',
      data: { discovered: discoveredDevices.length, updated: bulkOps.length, markedOffline: offlineCount }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Scan failed: ' + error.message });
  }
};

exports.updateDevice = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;
    const { alias, notes, type, location } = req.body;

    const filter = id.match(/^[0-9a-fA-F]{24}$/)
      ? { _id: new (require('mongodb').ObjectId)(id) }
      : { mac: id };

    const update = {};
    if (alias !== undefined) update.alias = alias;
    if (notes !== undefined) update.notes = notes;
    if (location !== undefined) update.location = location;
    if (type !== undefined) update['hardware.type'] = type;

    const result = await db.collection('network_devices').findOneAndUpdate(
      filter, { $set: update }, { returnDocument: 'after' }
    );

    if (!result) return res.status(404).json({ status: 'error', message: 'Device not found' });
    res.json({ status: 'success', data: { device: result } });
  } catch (error) { next(error); }
};

exports.enrichDevice = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    const filter = id.match(/^[0-9a-fA-F]{24}$/)
      ? { _id: new (require('mongodb').ObjectId)(id) }
      : { mac: id };

    const device = await db.collection('network_devices').findOne(filter);
    if (!device) return res.status(404).json({ status: 'error', message: 'Device not found' });
    if (device.status === 'offline') return res.status(400).json({ status: 'error', message: 'Cannot enrich offline device' });

    const details = await networkScanner.enrichDevice(device.ip);

    if (details) {
      const update = {};
      if (details.hardware?.os) update['hardware.os'] = details.hardware.os;
      if (details.openPorts) update.openPorts = details.openPorts;
      await db.collection('network_devices').updateOne(filter, { $set: update });
    }

    const updated = await db.collection('network_devices').findOne(filter);
    res.json({ status: 'success', data: { device: updated } });
  } catch (error) { next(error); }
};
