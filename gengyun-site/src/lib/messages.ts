export type MessageType = "interaction" | "system";

export type Message = {
  id: string;
  title: string;
  text: string;
  detail: string;
  type: MessageType;
  to: string;
  time: string;
};

export const MESSAGES: Message[] = [
  {
    id: "n1",
    title: "禾间笔记回复了你的观察",
    text: "“可以再补一张叶鞘的近照。”",
    detail:
      "这是一条本地演示消息，用来展示互动提醒的样子。登录云端账号后，社区回复、复核结果与系统提醒会从服务器送达这里，并同步已读状态。",
    type: "interaction",
    to: "/community",
    time: "10 分钟前",
  },
  {
    id: "n2",
    title: "你的情景视频已准备好",
    text: "演示制剂 A · 近期创作片段",
    detail:
      "情景视频是明确标识的演示推演，不是科学预测，也不代表按标签正常使用的结果。可以在「情景视频」页查看并自行判断。",
    type: "system",
    to: "/videos",
    time: "30 分钟前",
  },
  {
    id: "n3",
    title: "欢迎来到耕云",
    text: "从一次田间观察，开始探索。",
    detail:
      "建议从一次标签核对或一株杂草开始：先看清是什么，再谈怎么处理。任何登记信息和包装标签，都比演示页更可靠。",
    type: "system",
    to: "/",
    time: "今天",
  },
];