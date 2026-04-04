const { spawn } = require('child_process');
const xml2js = require('xml2js');
const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
const NMAP_MISSING_MESSAGE = 'nmap is not installed on the host. Install nmap to use network scanning.';

class NetworkScanner {
  constructor() {
    this.isScanning = false;
  }

  normalizeSpawnError(err) {
    if (err?.code === 'ENOENT') {
      const dependencyError = new Error(NMAP_MISSING_MESSAGE);
      dependencyError.code = 'DEPENDENCY_MISSING';
      dependencyError.dependency = 'nmap';
      dependencyError.cause = err;
      return dependencyError;
    }

    return err;
  }

  async parseNmapOutput(xmlData) {
    try {
      const result = await parser.parseStringPromise(xmlData);
      if (!result.nmaprun || !result.nmaprun.host) return [];

      const hosts = Array.isArray(result.nmaprun.host) ? result.nmaprun.host : [result.nmaprun.host];

      return hosts.map(host => {
        if (host.status.state !== 'up') return null;

        let ip = '', mac = '', vendor = '';
        const addresses = Array.isArray(host.address) ? host.address : [host.address];
        addresses.forEach(addr => {
          if (addr.addrtype === 'ipv4') ip = addr.addr;
          if (addr.addrtype === 'mac') { mac = addr.addr; vendor = addr.vendor || ''; }
        });

        if (!mac) return null;

        let hostname = '';
        if (host.hostnames?.hostname) {
          const hNames = Array.isArray(host.hostnames.hostname) ? host.hostnames.hostname : [host.hostnames.hostname];
          hostname = hNames[0].name;
        }

        return { ip, mac, vendor, hostname, status: 'online', lastSeen: new Date() };
      }).filter(Boolean);
    } catch (error) {
      console.error('Error parsing Nmap XML:', error);
      return [];
    }
  }

  scanNetwork(targetCIDR) {
    return new Promise((resolve, reject) => {
      if (this.isScanning) return reject(new Error('Scan already in progress'));
      this.isScanning = true;

      const nmap = spawn('nmap', ['-sn', '-oX', '-', targetCIDR]);
      let xmlOutput = '', errorOutput = '';

      nmap.stdout.on('data', (data) => { xmlOutput += data.toString(); });
      nmap.stderr.on('data', (data) => { errorOutput += data.toString(); });

      nmap.on('close', async (code) => {
        this.isScanning = false;
        if (code !== 0) {
          console.error('Nmap Error:', errorOutput);
          return reject(new Error(`Nmap exited with code ${code}`));
        }
        try { resolve(await this.parseNmapOutput(xmlOutput)); }
        catch (err) { reject(err); }
      });

      nmap.on('error', (err) => { this.isScanning = false; reject(this.normalizeSpawnError(err)); });
    });
  }

  enrichDevice(ip) {
    return new Promise((resolve, reject) => {
      const nmap = spawn('nmap', ['-O', '-sV', '--top-ports', '100', '-oX', '-', ip]);
      let xmlOutput = '';

      nmap.stdout.on('data', (data) => { xmlOutput += data.toString(); });

      nmap.on('close', async (code) => {
        if (code !== 0) return resolve(null);
        try {
          const result = await parser.parseStringPromise(xmlOutput);
          if (!result.nmaprun?.host) return resolve(null);

          const host = result.nmaprun.host;
          let osMatch = '';
          if (host.os?.osmatch) {
            const matches = Array.isArray(host.os.osmatch) ? host.os.osmatch : [host.os.osmatch];
            osMatch = matches[0].name;
          }

          const ports = [];
          if (host.ports?.port) {
            const portList = Array.isArray(host.ports.port) ? host.ports.port : [host.ports.port];
            portList.forEach(p => {
              if (p.state.state === 'open') {
                ports.push({ port: parseInt(p.portid), protocol: p.protocol, service: p.service?.name || 'unknown', state: 'open' });
              }
            });
          }

          resolve({ ip, hardware: { os: osMatch }, openPorts: ports });
        } catch { resolve(null); }
      });

      nmap.on('error', (err) => reject(this.normalizeSpawnError(err)));
    });
  }
}

module.exports = new NetworkScanner();
