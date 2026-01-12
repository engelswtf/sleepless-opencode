import { Task } from "./db.js";
import { WebhookNotifier, WebhookConfig } from "./webhook.js";

export interface Notification {
  type: "started" | "completed" | "failed";
  task: Task;
  message: string;
  result?: string;
  error?: string;
}

export interface NotificationChannel {
  send(notification: Notification): Promise<void>;
}

export class Notifier {
  private channels: NotificationChannel[] = [];
  private webhooks: WebhookNotifier[] = [];

  addChannel(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  addWebhook(config: WebhookConfig): void {
    this.webhooks.push(new WebhookNotifier(config));
  }

  async notify(notification: Notification): Promise<void> {
    const channelPromises = this.channels.map((channel) =>
      channel.send(notification).catch((err) => {
        console.error("[notifier] Failed to send notification:", err);
      })
    );

    const webhookPromises = this.webhooks.map((webhook) =>
      webhook.notify(
        notification.type,
        notification.task,
        notification.result,
        notification.error
      ).catch((err) => {
        console.error("[notifier] Webhook failed:", err);
      })
    );

    await Promise.all([...channelPromises, ...webhookPromises]);
  }
}
