import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';

const TRACKER_PORT = 3002;

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

let sock;
let isConnected = false;
let currentQr = null;
let currentProbeMethod = 'delete';

const trackers = new Map();

async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: true,
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQr = qr;
      io.emit('wa-qr', qr);
    }
    if (connection === 'close') {
      isConnected = false;
      currentQr = null;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectWA();
    } else if (connection === 'open') {
      isConnected = true;
      currentQr = null;
      io.emit('wa-connected');
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

connectWA();

class Tracker {
  constructor(sock, jid) {
    this.sock = sock;
    this.jid = jid;
    this.active = false;
    this.history = [];
    this.state = 'Calibrating...';
    this.lastRtt = 0;
    this.onUpdate = null;
    this.probes = new Map();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.listen();
    this.loop();
  }

  listen() {
    this.sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (u.key.remoteJid === this.jid && u.key.fromMe) {
          if (u.update.status === 3) this.handleAck(u.key.id);
        }
      }
    });
    this.sock.ws.on('CB:receipt', (node) => {
      const { attrs } = node;
      if (attrs.type === 'inactive' && attrs.from) {
        const base = attrs.from.split('@')[0].split(':')[0];
        if (this.jid === attrs.from || this.jid === `${base}@s.whatsapp.net`) {
          this.handleAck(attrs.id);
        }
      }
    });
  }

  async loop() {
    while (this.active) {
      await this.probe();
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 100));
    }
  }

  async probe() {
    const prefixes = ['3EB0','BAE5','F1D2','A9C4','7E8B','C3F9','2D6A'];
    const id = prefixes[Math.floor(Math.random()*prefixes.length)] + Math.random().toString(36).substring(2,10).toUpperCase();
    try {
      const start = Date.now();
      if (currentProbeMethod === 'delete') {
        await this.sock.sendMessage(this.jid, { delete: { remoteJid: this.jid, fromMe: true, id } });
      } else {
        await this.sock.sendMessage(this.jid, {
          react: { text: '👻', key: { remoteJid: this.jid, fromMe: false, id } }
        });
      }
      this.probes.set(id, start);
      const timer = setTimeout(() => {
        if (this.probes.has(id)) {
          this.probes.delete(id);
          this.offline(Date.now() - start);
        }
      }, 10000);
      this.probes._timers = this.probes._timers || new Map();
      this.probes._timers.set(id, timer);
    } catch {}
  }

  handleAck(msgId) {
    if (this.probes.has(msgId)) {
      const start = this.probes.get(msgId);
      this.probes.delete(msgId);
      if (this.probes._timers?.has(msgId)) {
        clearTimeout(this.probes._timers.get(msgId));
        this.probes._timers.delete(msgId);
      }
      const rtt = Date.now() - start;
      if (rtt <= 5000) this.add(rtt);
    }
  }

  add(rtt) {
    this.lastRtt = rtt;
    this.history.push(rtt);
    if (this.history.length > 2000) this.history.shift();
    this.updateState();
    this.emit();
  }

  offline(rtt) {
    this.state = 'Offline';
    this.lastRtt = rtt;
    this.emit();
  }

  updateState() {
    if (this.history.length < 3) { this.state = 'Calibrating...'; return; }
    const sorted = [...this.history].sort((a,b) => a-b);
    const mid = Math.floor(sorted.length/2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
    const threshold = median * 0.9;
    const avg = this.history.slice(-3).reduce((a,b)=>a+b,0) / 3;
    this.state = avg < threshold ? 'Online' : 'Standby';
  }

  emit() {
    if (this.onUpdate) {
      const sorted = [...this.history].sort((a,b)=>a-b);
      const mid = Math.floor(sorted.length/2);
      const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2) : 0;
      this.onUpdate({
        jid: this.jid,
        state: this.state,
        rtt: this.lastRtt,
        median,
        threshold: median * 0.9,
        history: this.history.slice(-50),
      });
    }
  }

  stop() {
    this.active = false;
  }
}

io.on('connection', (socket) => {
  if (currentQr) socket.emit('wa-qr', currentQr);
  if (isConnected) socket.emit('wa-connected');
  socket.emit('probe-method', currentProbeMethod);

  socket.on('get-contacts', () => {
    const contacts = [...trackers.entries()].map(([jid]) => ({ jid }));
    socket.emit('contacts', contacts);
  });

  socket.on('add-contact', async (number) => {
    const clean = number.replace(/\D/g, '');
    const jid = clean + '@s.whatsapp.net';
    if (trackers.has(jid)) return socket.emit('error', 'Already tracking');

    try {
      const exists = await sock.onWhatsApp(jid);
      if (!exists?.[0]?.exists) return socket.emit('error', 'Number not on WhatsApp');

      const t = new Tracker(sock, exists[0].jid);
      trackers.set(exists[0].jid, t);
      t.onUpdate = (data) => {
        io.emit('tracker-update', data);
      };
      t.start();
      socket.emit('contact-added', { jid: exists[0].jid, number: clean });
      let pp = null;
      try { pp = await sock.profilePictureUrl(exists[0].jid, 'image'); } catch {}
      io.emit('profile-pic', { jid: exists[0].jid, url: pp });
    } catch (err) {
      socket.emit('error', 'Verification failed');
    }
  });

  socket.on('remove-contact', (jid) => {
    const t = trackers.get(jid);
    if (t) { t.stop(); trackers.delete(jid); }
    socket.emit('contact-removed', jid);
  });

  socket.on('set-probe-method', (method) => {
    if (method !== 'delete' && method !== 'reaction') return;
    currentProbeMethod = method;
    io.emit('probe-method', method);
  });
});

httpServer.listen(TRACKER_PORT, () => {
  console.log(`🔍 WhatsApp Tracker running on port ${TRACKER_PORT}`);
});
