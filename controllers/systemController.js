const pidusage = require('pidusage');
const os = require('os');

const getSystemStats = async (req, res) => {
  try {
    const stats = await pidusage(process.pid);
    res.json({
      status: 'success',
      data: {
        process: {
          cpu: stats.cpu, memory: stats.memory,
          uptime: stats.elapsed, pid: stats.pid
        },
        system: {
          total_mem: os.totalmem(), free_mem: os.freemem(),
          load_avg: os.loadavg(), cpus: os.cpus().length,
          platform: os.platform(), uptime: os.uptime()
        },
        timestamp: new Date()
      }
    });
  } catch (error) {
    console.error('Error fetching system stats:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch system stats', error: error.message });
  }
};

module.exports = { getSystemStats };
