import { App, Modal, Setting, Notice } from "obsidian";
import type BaiduSyncPlugin from "../main";

export class DecryptMigrationModal extends Modal {
  private plugin: BaiduSyncPlugin;
  private onComplete?: () => void;
  private clearPasswordOnFinish: boolean = false;
  private isMigrating: boolean = false;
  private statusTextEl: HTMLElement | null = null;

  constructor(app: App, plugin: BaiduSyncPlugin, onComplete?: () => void) {
    super(app);
    this.plugin = plugin;
    this.onComplete = onComplete;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("baidu-sync-log-modal");

    contentEl.createEl("h2", { text: "🔓 全量解密并转为明文同步" });

    const desc = contentEl.createDiv({
      cls: "setting-item-description baidu-sync-modal-desc",
    });
    desc.setText(
      "此功能将协助你安全停用 E2EE 端到端加密并恢复为明文同步：\n" +
      "1. 预拉取校验：自动拉取并解密云端所有文件至本地，确保本地知识库绝对完整；\n" +
      "2. 明文覆盖上传：以无加密明文全量重新上传本地全部笔记与配置至百度网盘，彻底覆盖历史密文；\n" +
      "3. 状态收尾：自动关闭【开启端到端加密】开关并更新同步清单。"
    );

    const warnBox = contentEl.createDiv({
      cls: "setting-item-description baidu-sync-modal-desc baidu-sync-warning-box",
    });
    warnBox.setText(
      "⚠️ 安全提示：迁移完成后，你在百度网盘中的文件将变为可直读的原始明文数据。请确保当前设备已配置正确的 E2EE 解密密码。"
    );

    new Setting(contentEl)
      .setName("迁移成功后清空已保存的密码")
      .setDesc("默认关闭（建议保留原密码作为防呆备份）。若开启，迁移完成后将同步清空设置中的密码。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.clearPasswordOnFinish)
          .onChange((val) => {
            this.clearPasswordOnFinish = val;
          });
      });

    const statusContainer = contentEl.createDiv({ cls: "baidu-sync-migration-status" });
    this.statusTextEl = statusContainer.createDiv({
      cls: "setting-item-description",
      text: "准备就绪，点击下方按钮开始迁移。"
    });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("开始解密迁移")
          .setCta()
          .onClick(async () => {
            if (this.isMigrating) return;
            if (!this.plugin.settings.accessToken) {
              new Notice("请先完成百度网盘账号绑定！");
              return;
            }

            this.isMigrating = true;
            btn.setDisabled(true);
            btn.setButtonText("迁移处理中...");

            try {
              if (this.statusTextEl) {
                this.statusTextEl.setText("第 1 步：正在拉取并解密云端所有文件以确保本地完整...");
              }

              const result = await this.plugin.engine.convertVaultToPlaintext((processed, total, path) => {
                if (this.statusTextEl) {
                  this.statusTextEl.setText(`第 2 步：正在明文重新上传覆盖网盘 (${processed}/${total}): ${path}`);
                }
              });

              if (result.success) {
                this.plugin.settings.enableE2EE = false;
                if (this.clearPasswordOnFinish) {
                  this.plugin.settings.e2eePassword = "";
                }
                await this.plugin.saveSettings();

                if (this.statusTextEl) {
                  this.statusTextEl.setText(`🎉 迁移圆满成功！已将 ${result.total} 个文件明文同步至网盘，E2EE 加密已关闭。`);
                }
                new Notice("🎉 百度网盘端所有文件已成功转为明文！");
                this.onComplete?.();
              } else {
                if (this.statusTextEl) {
                  this.statusTextEl.setText(`⚠️ 迁移部分完成，但有 ${result.errors} 个文件失败，请查看同步日志。`);
                }
                new Notice(`明文迁移完成，但存在 ${result.errors} 个失败项，请检查日志`);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              if (this.statusTextEl) {
                this.statusTextEl.setText(`❌ 迁移中止: ${msg}`);
              }
              new Notice(`迁移失败: ${msg}`);
            } finally {
              this.isMigrating = false;
              btn.setDisabled(false);
              btn.setButtonText("重新执行迁移");
            }
          });
      })
      .addButton((btn) => {
        btn.setButtonText("关闭").onClick(() => {
          this.close();
        });
      });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
