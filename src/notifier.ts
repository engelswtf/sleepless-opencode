import { Task } from "./db.js";

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

  addChannel(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  async notify(notification: Notification): Promise<void> {
    const promises = this.channels.map((channel) =>
      channel.send(notification).catch((err) => {
        console.error("[notifier] Failed to send notification:", err);
      })
    );
    await Promise.all(promises);
  }
}
