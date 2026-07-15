import net from "net";
import { EventEmitter } from "events";
import { setTimeout } from "timers/promises";

import { TelnetSocket } from "telnet-stream";

/** @typedef {import("@elgato/streamdeck").Logger} Logger */
/** @typedef {import("@elgato/streamdeck").Action} Action */

/** @typedef {import("../plugin").PluginContext} PluginContext */
/** @typedef {import("./tracker").ReceiverInfo} ReceiverInfo */

const TELNET_PORT = 23;
const HTTP_PORT = 80;
const HEOS_PORT = 1255;
const HTTP_COMMAND_PATH = "/goform/formiPhoneAppDirect.xml";
const HTTP_STATUS_PATH = "/goform/formMainZone_MainZoneXmlStatus.xml";
const HTTP_STATUS_Z2_PATH = "/goform/formZone2_Zone2XmlStatus.xml";
const HTTP_POLL_INTERVAL = 5000;
const HEOS_POLL_INTERVAL = 5000;

/**
 * @typedef {Object} ReceiverEvent
 * @property { "connected" 
 * 			 | "closed"
 * 			 | "powerChanged"
 * 			 | "volumeChanged"
 * 			 | "muteChanged"
 * 			 | "status"
 * 			 | "sourceChanged"
 * 			 | "dynamicVolumeChanged"} type - The type of event.
 * @property {number} [zone] - The zone that the event occurred on.
 * @property {AVRConnection} connection - The receiver connection.
 * @property {Action[]} [actions] - The actions to inform of the event.
 */

/**
 * @typedef {"OFF" | "LIT" | "MED" | "HEV" | undefined} DynamicVolume
 */

/**
 * @typedef {Object} ReceiverZoneStatus
 * @property {boolean} power - Whether the zone is powered on.
 * @property {number} volume - The current volume of the zone.
 * @property {number} maxVolume - The (current) maximum volume of the receiver.
 * @property {DynamicVolume} [dynamicVolume] - Whether the volume is dynamic.
 * @property {boolean} muted - Whether the zone is muted.
 * @property {string} source - The current source of the zone.
 */

/**
 * @typedef {Object} ReceiverStatus
 * @property {ReceiverZoneStatus[]} zones - The status of each zone.
 * @property {string} statusMsg - The status message for this connection.
 */

const sources = {
	"PHONO": "Phono",
	"CD": "CD",
	"TUNER": "Tuner",
	"DVD": "DVD",
	"BD": "Blu-ray",
	"TV": "TV Audio",
	"SAT/CBL": "Cable / Satellite",
	"MPLAY": "Media Player",
	"GAME": "Game",
	"HDRADIO": "HD Radio",
	"NET": "Online Music",
	"PANDORA": "Pandora",
	"SIRIUSXM": "SiriusXM",
	"SPOTIFY": "Spotify",
	"LASTFM": "Last.fm",
	"FLICKR": "Flickr",
	"IRADIO": "iRadio",
	"SERVER": "Server",
	"FAVORITES": "Favorites",
	"AUX": "Aux",
	"AUX1": "Aux 1",
	"AUX2": "Aux 2",
	"AUX3": "Aux 3",
	"AUX4": "Aux 4",
	"AUX5": "Aux 5",
	"AUX6": "Aux 6",
	"AUX7": "Aux 7",
	"BT": "Bluetooth",
	"USB/IPOD": "USB/iPod",
	"USB": "USB",
	"IPD": "iPod",
	"IRP": "iRadio",
	"FVP": "",
	"ON": "Video Select: On",
	"OFF": "Video Select: Off"
};

/**
 * Represents a connection to a Denon AVR receiver
 */
export class AVRConnection {
	/** @type {Logger} */
	logger;

	/**
	 * The current status of the receiver
	 * @type {ReceiverStatus}
	 */
	status = {
		zones: [
			{
				power: false,
				volume: 0,
				maxVolume: 85,
				muted: false,
				dynamicVolume: "OFF",
				source: "",
			},
			{
				power: false,
				volume: 0,
				maxVolume: 85,
				muted: false,
				source: "",
			},
		],
		statusMsg: "Initializing...",
	};

	/**
	 * The event emitter for this instance
	 * @type {EventEmitter}
	 */
	#eventEmitter = new EventEmitter();

	/**
	 * The listeners for this instance
	 * @type {string[]}
	 */
	#listenerIds = [];

	/**
	 * The raw socket connection to the receiver
	 * @type {net.Socket | undefined}
	 */
	#rawSocket;

	/**
	 * The telnet socket connection to the receiver
	 * @type {TelnetSocket | undefined}
	 */
	#telnet;

	/**
	 * The number of times in a row that we've retried connecting
	 * @type {number}
	 */
	#reconnectCount = 0;

	/**
	 * The connection mode: "telnet" (port 23), "http" (port 80 HTTP API), or "heos" (port 1255 HEOS CLI)
	 * @type {"telnet" | "http" | "heos"}
	 */
	#mode = "telnet";

	/**
	 * The HTTP/HEOS polling timer
	 * @type {NodeJS.Timeout | undefined}
	 */
	#pollTimer;

	/**
	 * The HEOS player ID (used in HEOS mode)
	 * @type {number | undefined}
	 */
	#heosPlayerId;

	/**
	 * The HEOS telnet socket (used in HEOS mode)
	 * @type {TelnetSocket | undefined}
	 */
	#heosTelnet;

	/**
	 * The HEOS raw socket (used in HEOS mode)
	 * @type {net.Socket | undefined}
	 */
	#heosRawSocket;

	/**
	 * The host address of the receiver
	 * @type {string}
	 */
	#host;
	get host() { return this.#host; }

	/**
	 * The UUID of the receiver
	 * @type {string}
	 */
	#uuid;
	get uuid() { return this.#uuid; }

	static get sources() { return sources; }

	/**
	 * Create a new DenonAVR instance and attempt to connect to the receiver
	 * @param {PluginContext} plugin - The plugin context to use
	 * @param {string} uuid - The UUID of the receiver on the network
	 * @param {string} host - The IP address of the receiver to connect to
	 */
	constructor(plugin, uuid, host) {
		this.logger = plugin.logger.createScope(this.constructor.name);

		this.#host = host;
		this.#uuid = uuid;
		this.connect();
	}

	/**
	 * Connect to a receiver. Tries telnet (port 23) first; if refused, falls back to HTTP API (port 80), then HEOS CLI (port 1255).
	 */
	async connect() {
		if (this.#mode === "http") {
			return this.#connectHttp();
		}
		if (this.#mode === "heos") {
			return this.#connectHeos();
		}

		this.logger.debug(`Connecting to Denon receiver via telnet: ${this.#host}:${TELNET_PORT}`);
		this.status.statusMsg = "Connecting...";
		this.emit("status");

		let rawSocket = net.createConnection(TELNET_PORT, this.#host);
		let telnet = new TelnetSocket(rawSocket);

		// Connection lifecycle events
		telnet.on("connect", () => this.#onConnect());
		telnet.on("close", (hadError) => this.#onClose(hadError));
		telnet.on("error", (error) => this.#onError(error));

		// Ignore standard telnet negotiation
		telnet.on("do", (option) => telnet.writeWont(option));
		telnet.on("will", (option) => telnet.writeDont(option));

		// Data events
		telnet.on("data", (data) => this.#onData(data));

		// Assign the telnet socket to the instance
		this.#rawSocket = rawSocket;
		this.#telnet = telnet;
	}

	/**
	 * Connect via HTTP API (fallback for receivers with telnet disabled)
	 */
	async #connectHttp() {
		this.logger.info(`Connecting to Denon receiver via HTTP API: ${this.#host}:${HTTP_PORT}`);
		this.status.statusMsg = "Connecting (HTTP)...";
		this.emit("status");

		try {
			// Verify the receiver is reachable via HTTP
			const response = await fetch(`http://${this.#host}:${HTTP_PORT}${HTTP_STATUS_PATH}`);
			if (!response.ok) {
				this.status.statusMsg = `HTTP connection failed: ${response.status}`;
				this.logger.warn(this.status.statusMsg);
				this.emit("status");
				return;
			}

			this.#reconnectCount = 0;
			this.status.statusMsg = "Connected (HTTP).";
			this.logger.info(`Connected to Denon receiver via HTTP API at ${this.#host}`);

			this.emit("connected");

			// Request full status via HTTP
			await this.#pollHttpStatus();

			// Start polling for status updates
			this.#pollTimer = setInterval(() => this.#pollHttpStatus(), HTTP_POLL_INTERVAL);
		} catch (error) {
			this.status.statusMsg = `HTTP connection error: ${error.message}`;
			this.logger.warn(this.status.statusMsg);
			this.emit("status");

			// HTTP failed — fall back to HEOS CLI (port 1255)
			this.logger.info(`HTTP API unavailable at ${this.#host}, falling back to HEOS CLI.`);
			this.#mode = "heos";
			this.#reconnectCount = 0;
			this.#connectHeos();
		}
	}

	/**
	 * Poll receiver status via HTTP XML API
	 */
	async #pollHttpStatus() {
		try {
			// Poll main zone
			const mainResp = await fetch(`http://${this.#host}:${HTTP_PORT}${HTTP_STATUS_PATH}`);
			if (mainResp.ok) {
				const xml = await mainResp.text();
				this.#parseHttpStatusXml(xml, 0);
			}

			// Poll zone 2
			const z2Resp = await fetch(`http://${this.#host}:${HTTP_PORT}${HTTP_STATUS_Z2_PATH}`);
			if (z2Resp.ok) {
				const xml = await z2Resp.text();
				this.#parseHttpStatusXml(xml, 1);
			}
		} catch (error) {
			this.logger.warn(`HTTP status poll failed: ${error.message}`);
		}
	}

	/**
	 * Parse HTTP status XML response and update internal state
	 * @param {string} xml - The XML response body
	 * @param {number} zone - The zone index (0 = main, 1 = zone 2)
	 */
	#parseHttpStatusXml(xml, zone) {
		const status = this.status.zones[zone];

		// Parse power
		const powerMatch = xml.match(/<Power><value>(.+?)<\/value><\/Power>/);
		if (powerMatch) {
			const newPower = powerMatch[1] === "ON";
			if (newPower !== status.power) {
				status.power = newPower;
				this.emit("powerChanged", zone);
			}
		}

		// Parse volume
		const volMatch = xml.match(/<MasterVolume><value>(.+?)<\/value><\/MasterVolume>/);
		if (volMatch) {
			// HTTP API returns volume as e.g. "-40.0" (dB), convert to the 0-98 scale
			const dbValue = parseFloat(volMatch[1]);
			const newVolume = Math.round(dbValue + 80); // -80dB = 0, 0dB = 80
			if (newVolume !== status.volume) {
				status.volume = newVolume;
				this.emit("volumeChanged", zone);
			}
		}

		// Parse mute
		const muteMatch = xml.match(/<Mute><value>(.+?)<\/value><\/Mute>/);
		if (muteMatch) {
			const newMute = muteMatch[1] === "on";
			if (newMute !== status.muted) {
				status.muted = newMute;
				this.emit("muteChanged", zone);
			}
		}

		// Parse source (main zone only)
		if (zone === 0) {
			const srcMatch = xml.match(/<InputFuncSelect><value>(.+?)<\/value><\/InputFuncSelect>/);
			if (srcMatch && srcMatch[1] !== status.source) {
				status.source = srcMatch[1];
				this.emit("sourceChanged", zone);
			}
		}
	}

	/**
	 * Send a command via HTTP API
	 * @param {string} command - The AVR command string (e.g. "PWON", "MV50")
	 * @returns {Promise<boolean>} Whether the command was sent successfully
	 */
	async #sendHttpCommand(command) {
		try {
			const url = `http://${this.#host}:${HTTP_PORT}${HTTP_COMMAND_PATH}?${encodeURIComponent(command)}`;
			const response = await fetch(url);
			if (!response.ok) {
				this.logger.warn(`HTTP command failed (${response.status}): ${command}`);
				return false;
			}
			this.logger.debug(`Sent HTTP command: ${command}`);
			// Poll immediately after sending a command to get updated state
			this.#pollHttpStatus();
			return true;
		} catch (error) {
			this.logger.error(`Error sending HTTP command: ${error.message}`);
			return false;
		}
	}

	/**
	 * Connect via HEOS CLI (for Denon Home speakers and other HEOS-only devices)
	 */
	async #connectHeos() {
		this.logger.info(`Connecting to device via HEOS CLI: ${this.#host}:${HEOS_PORT}`);
		this.status.statusMsg = "Connecting (HEOS)...";
		this.emit("status");

		try {
			const socket = net.createConnection(HEOS_PORT, this.#host);
			const telnet = new TelnetSocket(socket);

			// Ignore standard telnet negotiation
			telnet.on("do", (option) => telnet.writeWont(option));
			telnet.on("will", (option) => telnet.writeDont(option));

			/** @type {string} */
			let buffer = "";

			await new Promise((resolve, reject) => {
				const timeout = setTimeout(5000).then(() => {
					reject(new Error("HEOS connection timeout"));
				});

				socket.on("error", (err) => reject(err));

				telnet.on("connect", () => {
					// Register for change events and get players
					telnet.write("heos://system/register_for_change_events?enable=on\r\n");
					telnet.write("heos://player/get_players\r\n");
				});

				telnet.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\r\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (!line) continue;
						try {
							const response = JSON.parse(line);
							if (response.heos?.command === "player/get_players" && response.heos?.result === "success") {
								const player = response.payload?.find((p) => p.ip === this.#host);
								if (player) {
									this.#heosPlayerId = player.pid;
									resolve(undefined);
								} else {
									reject(new Error(`No HEOS player found at ${this.#host}`));
								}
							}
						} catch (e) {
							// Not JSON yet, continue buffering
						}
					}
				});
			});

			this.#heosRawSocket = socket;
			this.#heosTelnet = telnet;
			this.#reconnectCount = 0;
			this.status.statusMsg = "Connected (HEOS).";
			this.logger.info(`Connected to HEOS device at ${this.#host}, player ID: ${this.#heosPlayerId}`);
			this.emit("connected");

			// HEOS devices are always "on" when reachable
			this.status.zones[0].power = true;
			this.status.zones[0].maxVolume = 100;
			this.emit("powerChanged", 0);

			// Set up ongoing event listener
			let eventBuffer = "";
			telnet.on("data", (data) => {
				eventBuffer += data.toString();
				const lines = eventBuffer.split("\r\n");
				eventBuffer = lines.pop() || "";
				for (const line of lines) {
					if (line) this.#onHeosData(line);
				}
			});

			// Poll for initial status
			await this.#pollHeosStatus();

			// Start polling
			this.#pollTimer = setInterval(() => this.#pollHeosStatus(), HEOS_POLL_INTERVAL);

		} catch (error) {
			this.status.statusMsg = `HEOS connection error: ${error.message}`;
			this.logger.warn(this.status.statusMsg);
			this.emit("status");

			if (this.#reconnectCount < 10) {
				this.#reconnectCount++;
				await setTimeout(3000);
				this.#connectHeos();
			}
		}
	}

	/**
	 * Handle incoming HEOS event data
	 * @param {string} line - A single JSON line from the HEOS CLI
	 */
	#onHeosData(line) {
		try {
			const response = JSON.parse(line);
			const command = response.heos?.command;
			const message = response.heos?.message || "";

			// Parse message params (key=value&key=value)
			const params = Object.fromEntries(
				message.split("&").map((p) => p.split("=")).filter((p) => p.length === 2)
			);

			if (command === "event/player_volume_changed") {
				if (parseInt(params.pid) === this.#heosPlayerId) {
					const newVolume = parseInt(params.level);
					const muted = params.mute === "on";
					const status = this.status.zones[0];
					if (newVolume !== status.volume) {
						status.volume = newVolume;
						this.emit("volumeChanged", 0);
					}
					if (muted !== status.muted) {
						status.muted = muted;
						this.emit("muteChanged", 0);
					}
				}
			} else if (command === "event/player_state_changed") {
				if (parseInt(params.pid) === this.#heosPlayerId) {
					// state: play, pause, stop — map to power
					const status = this.status.zones[0];
					const newPower = params.state === "play" || params.state === "pause";
					if (newPower !== status.power) {
						status.power = newPower;
						this.emit("powerChanged", 0);
					}
				}
			} else if (command === "player/get_volume" && response.heos?.result === "success") {
				const level = parseInt(params.level);
				const status = this.status.zones[0];
				if (level !== status.volume) {
					status.volume = level;
					this.emit("volumeChanged", 0);
				}
			} else if (command === "player/get_mute" && response.heos?.result === "success") {
				const muted = params.state === "on";
				const status = this.status.zones[0];
				if (muted !== status.muted) {
					status.muted = muted;
					this.emit("muteChanged", 0);
				}
			}
		} catch (e) {
			// Ignore unparseable lines
		}
	}

	/**
	 * Poll HEOS player status
	 */
	async #pollHeosStatus() {
		const telnet = this.#heosTelnet;
		if (!telnet || this.#heosPlayerId === undefined) return;

		telnet.write(`heos://player/get_volume?pid=${this.#heosPlayerId}\r\n`);
		telnet.write(`heos://player/get_mute?pid=${this.#heosPlayerId}\r\n`);
	}

	/**
	 * Send a HEOS CLI command
	 * @param {string} command - The full HEOS command URL
	 */
	#sendHeosCommand(command) {
		const telnet = this.#heosTelnet;
		if (!telnet) return false;

		try {
			telnet.write(`${command}\r\n`);
			this.logger.debug(`Sent HEOS command: ${command}`);
			return true;
		} catch (error) {
			this.logger.error(`Error sending HEOS command: ${error.message}`);
			return false;
		}
	}

	/**
	 * Disconnect from the receiver and clean up resources
	 */
	disconnect() {
		let rawSocket = this.#rawSocket;
		let telnet = this.#telnet;

		// Clear the listeners for this instance
		this.#listenerIds = [];

		// Clear polling timer
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = undefined;
		}

		// Close HEOS connection
		if (this.#heosTelnet) {
			this.#heosTelnet.destroy();
			this.#heosTelnet = undefined;
		}
		if (this.#heosRawSocket && !this.#heosRawSocket.destroyed) {
			this.#heosRawSocket.destroy();
			this.#heosRawSocket = undefined;
		}

		// Dispose of this instance's sockets
		this.#rawSocket = undefined;
		this.#telnet = undefined;

		if (telnet && rawSocket?.destroyed !== true) {
			telnet.destroy();

			// Set a timeout to clean up the sockets
			setTimeout(1000).then(() => {
				if (telnet && rawSocket?.destroyed !== true) {
					telnet.unref();
					rawSocket?.unref();
				}
			});
		}
	}

	/**
	 * Change the volume by the given delta
	 * @param {number} delta - The amount to change the volume by
	 * @param {number} [zone=0] - The zone to change the volume for
	 * @returns {boolean} Whether the command was sent successfully
	 */
	changeVolume(delta, zone = 0) {
		const status = this.status.zones[zone];
		if (!status.power || status.volume === undefined) return false;

		let command = ["MV", "Z2"][zone];

		if (delta === 1) {
			command += "UP";
		} else if (delta === -1) {
			command += "DOWN";
		} else {
			let newVolumeStr = Math.max(0, Math.min(status.maxVolume, Math.round(status.volume + delta)))
				.toString()
				.padStart(2, "0");
			command += newVolumeStr;
		}

		return this.#sendCommand(command);
	}

	/**
	 * Change the volume to the given value
	 * @param {number} value - The new volume value to set
	 * @param {number} [zone=0] - The zone to change the volume for
	 * @returns {boolean} Whether the command was sent successfully
	 */
	changeVolumeAbsolute(value, zone = 0) {
		const status = this.status.zones[zone];
		if (!status.power) return false;

		let command = ["MV", "Z2"][zone];
		command += value.toString().padStart(2, "0");

		return this.#sendCommand(command);
	}

	changeVolumeUp(zone = 0) {
		const status = this.status.zones[zone];
		if (!status.power) return false;

		let command = ["MV", "Z2"][zone]+"UP";
		return this.#sendCommand(command);
	}

	changeVolumeDown(zone = 0) {
		const status = this.status.zones[zone];
		if (!status.power) return false;

		let command = ["MV", "Z2"][zone]+"DOWN";
		return this.#sendCommand(command);
	}

	/**
	 * Set the mute state
	 * @param {boolean} [value] - The new mute state to set
	 * @param {number} [zone=0] - The zone to set the mute state for
	 * @returns {boolean} Whether the command was sent successfully
	 */
	setMute(value, zone = 0) {
		const status = this.status.zones[zone];
		if (!status.power) return false;

		if (value === undefined) value = !status.muted;

		let command = ["MU", "Z2MU"][zone];
		command += value ? "ON" : "OFF";

		this.#sendCommand(command);

		// Refresh the mute status to avoid synchronization issues
		if (this.#mode === "telnet") {
			this.#sendCommand("MU?");
		}

		return true;
	}

	/**
	 * Set the power state
	 * @param {boolean} [value] - The new power state to set. If not provided, toggle the current state.
	 * @param {number} [zone=0] - The zone to set the power state for
	 * @returns {boolean} Whether the command was sent successfully
	 */
	setPower(value, zone = 0) {
		const status = this.status.zones[zone];

		if (value === undefined) value = !status.power;

		let command = ["PW", "Z2"][zone];
		command += value ? "ON" : ["STANDBY", "OFF"][zone];

		return this.#sendCommand(command);
	}

	/**
	 * Set the source of the given zone
	 * @param {string} value - The source to set
	 * @param {number} [zone=0] - The zone to set the source for
	 * @returns {boolean} Whether the command was sent successfully
	 */
	setSource(value, zone = 0) {
		if (!value) return false;

		let command = ["SI", "Z2"][zone];
		command += value;

		return this.#sendCommand(command);
	}

	/**
	 * Set the video select source of the given zone
	 * @param {string} value - The source to set
	 * @returns {boolean} Whether the command was sent successfully
	 */
	setVideoSelectSource(value) {
		if (!value) return false;

		let command = "SV";
		command += value;

		return this.#sendCommand(command);
	}

	/**
	 * Set the dynamic volume state
	 * @param {DynamicVolume} value - The new dynamic volume state to set
	 * @returns {boolean} Whether the command was sent successfully
	 */
	setDynamicVolume(value) {
		let command = "PSDYNVOL ";
		command += value;

		return this.#sendCommand(command);
	}

	/**
	 * Send a command to the receiver using the current connection mode
	 * @param {string} command - The AVR command string
	 * @returns {boolean} Whether the command was sent (or queued) successfully
	 */
	#sendCommand(command) {
		if (this.#mode === "http") {
			this.#sendHttpCommand(command);
			return true;
		}

		if (this.#mode === "heos") {
			return this.#translateAndSendHeos(command);
		}

		const telnet = this.#telnet;
		if (!telnet) return false;

		try {
			telnet.write(command + "\r");
			this.logger.debug(`Sent telnet command: ${command}`);
		} catch (error) {
			this.logger.error(`Error sending telnet command: ${error.message}`);
			return false;
		}

		return true;
	}

	/**
	 * Translate an AVR command to a HEOS CLI command and send it
	 * @param {string} command - The AVR command string
	 * @returns {boolean} Whether the command was sent
	 */
	#translateAndSendHeos(command) {
		const pid = this.#heosPlayerId;
		if (pid === undefined) return false;

		if (command === "PWON") {
			// HEOS doesn't have true power on — already powered if reachable
			this.status.zones[0].power = true;
			this.emit("powerChanged", 0);
			return true;
		} else if (command === "PWSTANDBY") {
			// No standby in HEOS, but we can stop playback
			return this.#sendHeosCommand(`heos://player/set_play_state?pid=${pid}&state=stop`);
		} else if (command === "MUON") {
			return this.#sendHeosCommand(`heos://player/set_mute?pid=${pid}&state=on`);
		} else if (command === "MUOFF") {
			return this.#sendHeosCommand(`heos://player/set_mute?pid=${pid}&state=off`);
		} else if (command === "MU?") {
			return this.#sendHeosCommand(`heos://player/get_mute?pid=${pid}`);
		} else if (command === "MVUP") {
			return this.#sendHeosCommand(`heos://player/volume_up?pid=${pid}&step=2`);
		} else if (command === "MVDOWN") {
			return this.#sendHeosCommand(`heos://player/volume_down?pid=${pid}&step=2`);
		} else if (command.startsWith("MV")) {
			// MV50 → set volume to 50 (HEOS uses 0-100 scale)
			const vol = parseInt(command.substring(2));
			if (!isNaN(vol)) {
				return this.#sendHeosCommand(`heos://player/set_volume?pid=${pid}&level=${vol}`);
			}
		}

		this.logger.debug(`No HEOS translation for AVR command: ${command}`);
		return false;
	}

	/** @typedef {(...args: any[]) => void} EventListener */

	/**
	 * Subscribe to events from this receiver
	 * @param {EventListener} listener - The listener function to call when the event is emitted
	 * @param {string} id - The binding ID for this listener, should be the manifest ID of the action that is listening
	 */
	on(listener, id) {
		const listenerId = `${id}-${listener.name}`;

		// Don't add the same listener twice
		if (this.#listenerIds.includes(listenerId)) {
			return;
		}

		this.#listenerIds.push(listenerId);

		this.#eventEmitter.on("event", listener);
	}

	/**
	 * Emit an event from this receiver
	 * @param {ReceiverEvent["type"]} type - The type of event to emit
	 * @param {ReceiverEvent["zone"]} [zone] - The zone that the event occurred on
	 */
	emit(type, zone = 0) {
		/** @type {ReceiverEvent} */
		const payload = { type, zone, connection: this };
		this.#eventEmitter.emit("event", payload);
	}

	/**
	 * Handle connection events
	 */
	#onConnect() {
		this.logger.debug(`Telnet connection established to Denon receiver at ${this.#host}`);

		this.#reconnectCount = 0;
		this.status.statusMsg = "Connected.";

		this.emit("connected");

		this.#requestFullReceiverStatus();
	}

	/**
	 * Handle connection closing event
	 * @param {boolean} [hadError=false] - Whether the connection was closed due to an error.
	 */
	#onClose(hadError = false) {
		(hadError ? this.logger.warn : this.logger.debug)(`Telnet connection to Denon receiver at ${this.#host} closed${hadError ? " due to error" : ""}.`);

		this.emit("closed");

		// Attempt to reconnect if we haven't given up yet
		if (this.#telnet && this.#reconnectCount < 10) {
			this.#reconnectCount++;

			setTimeout(1000).then(() => {
				this.logger.debug(`Trying to reconnect to Denon receiver at ${this.#host}. Attempt ${this.#reconnectCount}`);
				this.connect();
			});
		}
	}

	/**
	 * Incoming data from the receiver
	 * @param {Buffer | string} data
	 */
	#onData(data) {
		let lines = data.toString().split("\r");
		for (let line of lines) {
			if (line.length === 0) continue;

			let command = "";
			let parameter = "";
			let zone = 0;

			if (line.startsWith("Z2")) {
				// Zone 2 status messages start with "Z2"
				zone = 1;
				line = line.substring(2); // Remove the "Z2" prefix

				// Special parsing for zone 2 due to a lack of "command" portion
				if (parseInt(line.substring(0, 2)) > 0) {
					// Volume
					command = "MV";
					parameter = line.substring(2);
				} else if (line.startsWith("ON") || line.startsWith("OFF")) {
					// Power
					command = "PW";
					parameter = line;
				} else if (line in sources) {
					// Source
					command = "SI";
					parameter = line;
				} else {
					// Resume default parsing
					command = line.substring(0, 2);
					parameter = line.substring(2);
				}
			} else if (line.startsWith("PS")) {
				// Unclear what this meta-command stands for
				line = line.substring(2);  // Remove the "PS" prefix

				// These commands are all space-delimited from their values
				[command, parameter] = line.split(" ");
			} else {
				// Default parsing
				command = line.substring(0, 2);
				parameter = line.substring(2);
			}

			switch (command) {
				case "PW": // Power
					this.#onPowerChanged(parameter, zone);
					break;
				case "MV": // Volume or max volume
					this.#onVolumeChanged(parameter, zone);
					break;
				case "MU": // Mute
					this.#onMuteChanged(parameter, zone);
					break;
				case "SI": // Source
					this.#onSourceChanged(parameter, zone);
					break;
				case "DYNVOL": // Dynamic volume
					this.#onDynamicVolumeChanged(parameter);
					break;
				default:
					this.logger.warn(`Unhandled message from receiver at ${this.#host} Z${zone === 0 ? "M" : "2"}: ${line}`);
					break;
			}
		}
	}

	/**
	 * Handle a power changed message from the receiver
	 * @param {string} parameter - The parameter from the receiver
	 * @param {number} [zone=0] - The zone that the power status changed for
	 */
	#onPowerChanged(parameter, zone = 0) {
		const status = this.status.zones[zone];

		// The receiver will send "ON" or "STANDBY" in zone 1, and "ON" or "OFF" in zone 2
		// It also repeats the power status at a regular interval, so we don't need to emit an event for every message
		const newStatus = parameter === "ON";
		if (newStatus === status.power) return;

		status.power = newStatus;
		this.logger.debug(`Updated receiver power status for ${this.#host} Z${zone === 0 ? "M" : "2"}: ${status.power}`);

		this.emit("powerChanged", zone);

		// Request the full status of the receiver if it is powered on
		// if (status.power) {
		// 	this.#requestFullReceiverStatus();
		// }
	}

	/**
	 * Handle a volume changed message from the receiver
	 * @param {string} parameter - The parameter from the receiver
	 * @param {number} [zone=0] - The zone that the volume status changed for
	 */
	#onVolumeChanged(parameter, zone = 0) {
		const status = this.status.zones[zone];

		if (parameter.startsWith("MAX")) {
			// The "MAX" extended command is not documented, but it is used by the receiver
			// Guessing this is the current maximum volume supported by the receiver
			// In testing, this value raises as the volume approaches the maximum
			// Ex: "MAX 855"
			let valueStr = parameter.substring(4);
			let newMaxVolume = parseInt(valueStr);
			if (valueStr.length === 3) {
				newMaxVolume = newMaxVolume / 10;
			}

			status.maxVolume = newMaxVolume;
			this.logger.debug(`Updated receiver max volume for ${this.#host} Z${zone === 0 ? "M" : "2"}: ${status.maxVolume}`);

			// this.emit("maxVolumeChanged");
		} else {
			let newVolume = parseInt(parameter);
			if (parameter.length === 3) {
				newVolume = newVolume / 10;
			}

			status.volume = newVolume;
			status.muted = false; // Implied by the volume changing
			this.logger.debug(`Updated receiver volume for ${this.#host} Z${zone === 0 ? "M" : "2"}: ${status.volume}`);

			this.emit("volumeChanged", zone);
		}
	}

	/**
	 * Handle a mute changed message from the receiver
	 * @param {string} parameter - The parameter from the receiver
	 * @param {number} [zone=0] - The zone that the mute status changed for
	 */
	#onMuteChanged(parameter, zone = 0) {
		const status = this.status.zones[zone];

		status.muted = parameter == "ON";
		this.logger.debug(`Updated receiver mute status for ${this.#host} Z${zone === 0 ? "M" : "2"}: ${status.muted}`);

		this.emit("muteChanged", zone);
	}

	/**
	 * Handle a source changed message from the receiver
	 * @param {string} parameter - The parameter from the receiver
	 * @param {number} [zone=0] - The zone that the source status changed for
	 */
	#onSourceChanged(parameter, zone = 0) {
		const status = this.status.zones[zone];

		status.source = parameter;
		this.logger.debug(`Updated receiver source for ${this.#host} Z${zone === 0 ? "M" : "2"}: ${status.source}`);

		this.emit("sourceChanged", zone);
	}

	/**
	 * Handle a dynamic volume changed message from the receiver
	 * @param {string} parameter - The parameter from the receiver
	 */
	#onDynamicVolumeChanged(parameter) {
		if (!["HEV", "MED", "LIT", "OFF"].includes(parameter)) {
			this.logger.warn(`Invalid dynamic volume value received from receiver at ${this.#host}: ${parameter}`);
			return;
		}

		const status = this.status;

		status.zones[0].dynamicVolume = /** @type {DynamicVolume} */ (parameter);
		this.logger.debug(`Updated receiver dynamic volume status for ${this.#host}: ${status.zones[0].dynamicVolume}`);

		this.emit("dynamicVolumeChanged");
	}

	/**
	 * Handle socket errors
	 * @param {Object} error
	 */
	#onError(error) {
		const status = this.status;

		if (error.code === "ENOTFOUND") {
			// If the host can't be looked up, give up.
			status.statusMsg = `Host not found: ${this.#host}`;
			this.disconnect();
		} else if (error.code === "ECONNREFUSED" && this.#mode === "telnet") {
			// Telnet port 23 is refused — fall back to HTTP API (port 80)
			this.logger.info(`Telnet connection refused at ${this.#host}:${TELNET_PORT}, falling back to HTTP API.`);
			this.disconnect();
			this.#mode = "http";
			this.#reconnectCount = 0;
			this.#connectHttp();
			return;
		} else {
			status.statusMsg = `Connection error: ${error.message} (${error.code})`;
		}

		this.logger.warn(status.statusMsg);
		this.emit("status");
	}

	/**
	 * Request the full status of the receiver
	 * Usually only needed when the connection is first established (telnet mode)
	 */
	#requestFullReceiverStatus() {
		if (this.#mode !== "telnet") return;

		const telnet = this.#telnet;
		if (!telnet) return;

		// Main zone
		telnet.write("PW?\r"); // Request the power status
		telnet.write("MV?\r"); // Request the volume
		telnet.write("MU?\r"); // Request the mute status
		telnet.write("PSDYNVOL ?\r"); // Request the dynamic volume status

		// Zone 2
		telnet.write("Z2PW?\r"); // Request the power status
		telnet.write("Z2MV?\r"); // Request the volume
		telnet.write("Z2MU?\r"); // Request the mute status
	}
}