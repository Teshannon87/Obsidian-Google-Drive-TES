import { checkConnection, getDriveClient } from "helpers/drive";
import { refreshAccessToken } from "helpers/ky";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	Menu,
} from "obsidian";

interface PluginSettings {
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	changesToken: string;
	autoSyncInterval: number; // minutes; 0 = disabled
	tokenServerUrl: string;   // defaults to https://ogd.richardxiong.com
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: "",
	operations: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	changesToken: "",
	autoSyncInterval: 0,
	tokenServerUrl: "",
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon: HTMLElement;
	syncing: boolean;
	statusBarItem: HTMLElement;
	private autoSyncTimer: number | null = null;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		if (!this.settings.refreshToken) {
			new Notice(
				"Google Drive Sync+: Please add your refresh token in Settings. Read the plugin readme carefully before syncing — incorrect use can cause data loss.",
				0
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Google Drive Sync+",
			(event) => {
				if (this.syncing) return;
				const menu = new Menu();

				menu.addItem((item) =>
					item
						.setTitle("Pull from Drive")
						.setIcon("cloud-download")
						.onClick(() => {
							pull(this);
						})
				);

				menu.addItem((item) =>
					item
						.setTitle("Push to Drive")
						.setIcon("cloud-upload")
						.onClick(() => {
							push(this);
						})
				);
				menu.addItem((item) =>
					item
						.setTitle("Reset from Drive")
						.setIcon("triangle-alert")
						.onClick(() => {
							reset(this);
						})
				);
				menu.showAtMouseEvent(event);
			}
		);

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings())
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(vault.on("create", this.handleCreate.bind(this)))
		);
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));

		checkConnection(this.settings.tokenServerUrl || undefined).then(async (connected) => {
			if (connected) {
				this.syncing = true;
				this.ribbonIcon.addClass("spin");
				this.updateStatusBar("syncing");
				await pull(this, true);
				await this.endSync();
			}
		});

		this.startAutoSync();
	}

	onunload() {
		this.stopAutoSync();
		return this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	handleCreate(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "delete") {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = "modify";
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = "create";
		}
		this.debouncedSaveSettings();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "create") {
			delete this.settings.operations[file.path];
		} else {
			this.settings.operations[file.path] = "delete";
		}
		this.debouncedSaveSettings();
	}

	handleModify(file: TFile) {
		const operation = this.settings.operations[file.path];
		if (operation === "create" || operation === "modify") {
			return;
		}
		this.settings.operations[file.path] = "modify";
		this.debouncedSaveSettings();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file.path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async startSync() {
		const serverUrl = this.settings.tokenServerUrl || undefined;
		if (!(await checkConnection(serverUrl))) {
			throw new Notice(
				"You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again."
			);
		}
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
		this.updateStatusBar("syncing");
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			this.settings.lastSyncedAt = Date.now();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() }
					)
				)
			);
		} else {
			this.settings.lastSyncedAt = Date.now();
		}

		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			return new Notice(
				"An error occurred fetching Google Drive changes token."
			);
		}
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
		syncNotice?.hide();
		this.updateStatusBar();
	}

	updateStatusBar(state?: "syncing" | "error") {
		if (!this.statusBarItem) return;
		if (state === "syncing") {
			this.statusBarItem.setText("GDrive: syncing...");
			return;
		}
		if (state === "error") {
			this.statusBarItem.setText("GDrive: error");
			return;
		}
		if (!this.settings.lastSyncedAt) {
			this.statusBarItem.setText("GDrive: never synced");
			return;
		}
		const elapsed = Date.now() - this.settings.lastSyncedAt;
		const minutes = Math.floor(elapsed / 60000);
		const hours = Math.floor(elapsed / 3600000);
		const days = Math.floor(elapsed / 86400000);
		let label: string;
		if (elapsed < 60000) label = "just now";
		else if (minutes < 60) label = `${minutes}m ago`;
		else if (hours < 24) label = `${hours}h ago`;
		else label = `${days}d ago`;
		this.statusBarItem.setText(`GDrive: ${label}`);
	}

	startAutoSync() {
		this.stopAutoSync();
		const interval = this.settings.autoSyncInterval;
		if (!interval || interval <= 0) return;
		this.autoSyncTimer = window.setInterval(async () => {
			if (this.syncing) return;
			const serverUrl = this.settings.tokenServerUrl || undefined;
			const connected = await checkConnection(serverUrl);
			if (!connected) return;
			this.syncing = true;
			this.ribbonIcon.addClass("spin");
			this.updateStatusBar("syncing");
			await pull(this, true);
			await this.endSync();
		}, interval * 60 * 1000);
		this.registerInterval(this.autoSyncTimer);
	}

	stopAutoSync() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const { vault } = this.app;

		containerEl.empty();

		containerEl.createEl("a", {
			href: "https://ogd.richardxiong.com",
			text: "Get refresh token (default server)",
		});

		new Setting(containerEl)
			.setName("Refresh token")
			.setDesc(
				"A refresh token is required to access your Google Drive for syncing. We suggest cloning your Google Drive vault to the current vault BEFORE syncing."
			)
			.addText((text) => {
				const cancel = () => {
					this.plugin.settings.refreshToken = "";
					text.setValue("");
					return this.plugin.saveSettings();
				};

				text.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
						if (!value) {
							return this.plugin.debouncedSaveSettings();
						}
						if (!(await refreshAccessToken(this.plugin))) {
							text.setValue("");
							return;
						}
						if (
							vault
								.getAllLoadedFiles()
								.filter(({ path }) => path !== "/").length > 0
						) {
							new Notice(
								"Your current vault is not empty! If you want the plugin to handle the initial sync, clear out the current vault first.",
								0
							);
							return cancel();
						}

						const changesToken =
							await this.plugin.drive.getChangesStartToken();
						if (!changesToken) {
							return new Notice(
								"An error occurred fetching Google Drive changes token."
							);
						}
						this.plugin.settings.changesToken = changesToken;

						await this.plugin.saveSettings();
						new Notice(
							"Refresh token saved! Reload Obsidian to activate sync.",
							0
						);
					});
			});

		new Setting(containerEl)
			.setName("Auto-sync interval")
			.setDesc(
				"Automatically pull from Google Drive every N minutes. Set to 0 to disable."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("0", "Disabled")
					.addOption("5", "Every 5 minutes")
					.addOption("10", "Every 10 minutes")
					.addOption("15", "Every 15 minutes")
					.addOption("30", "Every 30 minutes")
					.addOption("60", "Every hour")
					.setValue(String(this.plugin.settings.autoSyncInterval || 0))
					.onChange(async (value) => {
						this.plugin.settings.autoSyncInterval = parseInt(value);
						await this.plugin.saveSettings();
						this.plugin.startAutoSync();
					});
			});

		new Setting(containerEl)
			.setName("Token server URL")
			.setDesc(
				"URL of the server that converts refresh tokens to access tokens. Leave blank to use the default (ogd.richardxiong.com). Set to your own server for full independence."
			)
			.addText((text) => {
				text.setPlaceholder("https://ogd.richardxiong.com")
					.setValue(this.plugin.settings.tokenServerUrl || "")
					.onChange(async (value) => {
						this.plugin.settings.tokenServerUrl = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}
}
