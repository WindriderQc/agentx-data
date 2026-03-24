const liveData = require('../services/liveData');

exports.getState = async (req, res) => {
  res.json({ status: 'success', data: liveData.getState() });
};

exports.getConfig = async (req, res) => {
  try {
    const db = req.app.locals.db;
    const configs = await db.collection('livedataconfigs').find({}).toArray();
    const result = configs.reduce((acc, c) => { acc[c.service] = c.enabled; return acc; }, {});
    res.json({ status: 'success', data: result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
};

exports.updateConfig = async (req, res) => {
  const { service, enabled } = req.body;
  const valid = ['liveDataEnabled', 'iss', 'quakes', 'weather'];
  if (!valid.includes(service)) {
    return res.status(400).json({ status: 'error', message: `Invalid service. Must be: ${valid.join(', ')}` });
  }

  try {
    const db = req.app.locals.db;
    await db.collection('livedataconfigs').updateOne(
      { service }, { $set: { enabled, updatedAt: new Date() } }, { upsert: true }
    );
    await liveData.reloadConfig();
    res.json({ status: 'success', message: `${service} set to ${enabled}` });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
};

exports.getISS = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const data = await db.collection('isses').find({}).sort({ timeStamp: -1 }).limit(100).toArray();
    res.json({ status: 'success', data, count: data.length });
  } catch (error) { next(error); }
};

exports.getQuakes = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const data = await db.collection('quakes').find({}).toArray();
    res.json({ status: 'success', data, count: data.length });
  } catch (error) { next(error); }
};
