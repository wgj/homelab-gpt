import {WebsocketBuilder, Websocket} from 'websocket-ts';
import { v4 as uuidv4 } from 'uuid';
import {plainToInstance, instanceToPlain, Type} from 'class-transformer'

export class Message {
  id: string;
  role: string;
  message?: string;
  cost_tokens_completion?:number;
  cost_tokens_prompt?: number;
  cost_usd?: number;
  finish_reason?: string;
  error?: string;
  start_edited?: boolean;
}
export class Model {
  label: string
  value: string
  maxTokens: number
}

export class  Settings {
  determinism = 50;
  max_tokens = 1000;
  model = "gpt-4";
  api_key = "";
  prompt = "";
}

export class User {
  name: string
  id: string
  api_key?: string = null;
}

export class Chat {
  id: string;
  user_id: string;
  name = "";
  messages: Message[] = [];
  settings = new Settings();
  loaded? = false;
  temporary_name?: string = ""

  public label() {
    if (this.name) {
      return this.name;
    }

    if (this.settings?.prompt) {
      return this._clamp(this.settings.prompt);
    }

    for (const message of this.messages) {
      if (message.message) {
        return this._clamp(message.message);
      }
    }

    if (this.temporary_name) {
      return this.temporary_name;
    }

    return "New Chat";
  }

  private _clamp(value: string) {
    if (value.length > 200) {
      return value.substring(0, 200);
    } else {
      return value;
    }
  }

  public static createEmptyChat() {
    const chat = new Chat();
    chat.loaded = true;
    return chat;
  }
}

export class LocalSaveInfo {
  @Type(() => User)
  user?: User;

  @Type(() => Chat)
  chat?: Chat;
  
  version?: number;
}

export class AppData {
  chats: Chat[] = [];
  user: User = null;

  // Internal state, which should not be serialized
  currentChat?: Chat = null;
  unsavedChat?: Chat = null;
  models: Model[] = [];
  users: User[] = [];
  busy = false;
  _dirtySave:NodeJS.Timeout = null;
  abortController: AbortController|undefined = undefined;
  streamWebSocket: Websocket|undefined = undefined;
  publishCallback: () => void|undefined = undefined;

  constructor() {
  }

  public async changeUser(user: User) {
    if (user === null) {
      this.chats = [];
      this.user = null;
      this.publish();
      return;
    }
    this.user = user;

    const user_id = this.user.id;
    this.publish()
    const resp = await fetch("/api/chats", {
      body: JSON.stringify({user_id: user_id}),
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
    });
    const data = await resp.json();
    this.chats = data.chats.map((c: any) => plainToInstance(Chat, c));

    if (!this.currentChat) {
      this.currentChat = Chat.createEmptyChat();
    } else {
      for (let i = 0; i < this.chats.length; i++) {
        if (this.chats[i].id == this.currentChat.id) {
          this.chats[i] = this.currentChat;
        }
      }
    }

    this.publish();
  }

  public newChat() {
    const chat = new Chat();
    chat.id = uuidv4();
    chat.loaded = true;
    chat.user_id = this.user.id;
    this.chats.push(chat);
    this.openChat(chat);
  }

  public async deleteCurrentChat() {
    if (!this.isSaved()) {
      return;
    }

    await fetch("/api/chat/" + this.currentChat.id, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json"
      },
    });

    const index = this.chats.indexOf(this.currentChat);
    if (index >= 0) {
      this.chats.splice(index, 1);
    }
    if (this.currentChat == this.unsavedChat) {
      this.unsavedChat = null;
    }
    this.openChat(null);
    this.dirty(true);
  }

  public async saveCurrentDraft() {
    if (this.isSaved()) {
      console.log("chat was saved");
      return;
    }

    if (!this.user) {
      console.log("user was null");
      return;
    }

    this.currentChat.id = uuidv4();
    this.currentChat.user_id = this.user.id;
    if (!this.chats.includes(this.currentChat)) {
      this.chats.push(this.currentChat);
    }

    this.unsavedChat = null;
    this.openChat(this.currentChat);
    this.dirty();
  }

  public async openChat(chat: Chat) {
    console.log("Opening chat");
    console.log(chat);

    if (!chat) {
      if (this.isSaved()) {
        if (this.unsavedChat) {
          this.currentChat = this.unsavedChat;
        } else {
          const newChat = new Chat();
          newChat.id = uuidv4();
          newChat.loaded = true;
          this.currentChat = newChat;
        }
        this.unsavedChat = null;
      }
      this.publish();
      return;
    }

    if (this.currentChat != chat && !this.isSaved()) {
      // switching away from an unsaved chat, so stash it for later use.
      this.unsavedChat = this.currentChat;
    }

    if (chat.loaded) {
      console.log("Already loaded");
      this.currentChat = chat;
      this.publish();
      return;
    }

    this.currentChat = chat;
    this.publish();
    const resp = await fetch("/api/chat/" + chat.id);
    const data = plainToInstance(Chat, await resp.json());
    data.loaded = true;
    let found = false;
    for(let i = 0; i < this.chats.length; i++) {
      if (this.chats[i].id == data.id) {
        this.chats[i] = data;
        found = true;
        break;
      }
    }
    if (!found) {
      this.chats.push(data);
    }
    this.currentChat = data;
    this.publish();
  }

  public async cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }

    if (this.streamWebSocket) {
      this.streamWebSocket.close();
      this.streamWebSocket = undefined;
    }
    this.busy = false;
    this.dirty();
  }

  public async delete(msg: Message) {
    if (!this.currentChat) {
      return
    }
    await this.cancel();
    const index = this.currentChat.messages.indexOf(msg);
    if (index >= 0) {
      this.currentChat.messages.splice(index, 1);
    }
    this.dirty();
  }

  public insertMessage(oldMessage: Message, newMessage: Message) {
    if (!this.currentChat) {
      return
    }
    let index = 0;
    if (oldMessage) {
      index = this.currentChat.messages.indexOf(oldMessage) + 1;
    }

    this.currentChat.messages.splice(index, 0, newMessage);
    this.dirty();
  }

  public truncate(msg: Message) {
    if (!this.currentChat) {
      return
    }
    const index = this.currentChat.messages.indexOf(msg);
    if (index >= 0) {
      this.currentChat.messages.splice(index, this.currentChat.messages.length - index);
    }
  }

  public async continue(cont: Message, prompt: string, model: string, determinism: number, maxTokens: number, apiKey: string) {
    if (!this.currentChat) {
      return
    }
    const toSend: Message[] = [];
    for (const msg of this.currentChat.messages) {
      toSend.push(msg);
      if(msg == cont) {
        break;
      }
    }
    await this.chat(prompt, model, determinism, maxTokens, apiKey, toSend, cont);
  }

  public async chat(prompt: string, model: string, determinism: number, maxTokens: number, api_key: string, messages: Message[]=null, message: Message = null) {
    await this.cancel();
    this.busy = true;
    const app = this;
    const chat = this.currentChat;
    if (!chat) {
      return;
    }
    if (messages == null) {
      messages = [...chat.messages];
    }
    let continuation = "";
    if (message == null) {
      message = {
        role: "assistant",
        message: "...",
        id: uuidv4()
      };
      chat.messages.push(message);
    } else {
      continuation = message.message;
    }
    const request = {
      messages: messages,
      model: model,
      temperature: ((100 - determinism) / 100) * 2,
      prompt: prompt,
      id: message.id,
      max_tokens: maxTokens,
      continuation: continuation,
      api_key: api_key,
    };
    const index = chat.messages.indexOf(message);

    const wsProtocol = window.location.protocol == 'https:' ? 'wss' : 'ws';
    this.streamWebSocket = new WebsocketBuilder(wsProtocol + '://' + window.location.host + '/api/ws/chat')
      .onOpen((i, _ev) => {
        console.log('Connection opened');
        i.send(JSON.stringify(request));
      })
      .onClose((_i, _ev) => {
        console.log('Connection Closed');
        app.busy = false;
        app.publish();
        app.dirty();
      })
      .onError((_, ev) => {
        console.log('Connect Error');
        message = {...message};
        message.error = "Websocket error: " + ev;
        chat.messages[index] = message;
        app.busy = false;
        app.publish();
        app.dirty();
      })
      .onMessage((_i, ev) => {
        const data = JSON.parse(ev.data);

        // TODO: this should look up the message based on its id.
        chat.messages[index] = data;
        message = data;
        app.publish();
      })
      .onRetry((_i, _ev) => {
        console.log("retry");
      })
      .build();
  }

  private publish() {
    if (this.publishCallback) {
      this.publishCallback();
    }
  }

  public bindToUpdates(callback: () => void) {
    this.publishCallback = callback;
  }

  public getCurrentModel() {
    if (this.currentChat) {
      for (const model of this.models) {
        if (model.value == this.currentChat.settings.model) {
          return model;
        }
      }
    }
    return this.models[1];
  }

  public toJSON() {
    const finalObj: any = {};
    finalObj["user"] = instanceToPlain(this.user);
    finalObj["currentChat"] = instanceToPlain(this.currentChat);
    finalObj['serializationVersion'] = 3;
    return finalObj;
  }

  public static load(source: any = null) {
    if (source == null) {
      const fromStorage = localStorage.getItem("appData");
      if (fromStorage) {
        source = plainToInstance(LocalSaveInfo, this.upgradeStoredData(JSON.parse(fromStorage)));
      } else {
        source = new LocalSaveInfo();
      }
    }

    const data = new AppData();
    if (source.user) {
      data.user = source.user;
    }
    if (source.chat) {
      data.currentChat = source.chat;
      data.currentChat.loaded = true;
    } else {
      data.currentChat = Chat.createEmptyChat();
    }
    return data;
  }

  public static upgradeStoredData(source: any) {
    if (source.serializationVersion == 1) {
      for (const message of source.messages) {
        if (message.cost_tokens) {
            message.cost_tokens_completion = message.cost_tokens;
            message.cost_tokens = undefined;
        }
        source.serializationVersion = 2;
      }
    }

    if (source.serializationVersion == 2) {
      const chat = source;
      source = {
        chat: chat,
        user: null,
        serializationVersion: 3,
      }
    }
    return source;
  }

  public static tryLoad() {
    try {
      return this.load();
    } catch (e) {
      console.error(e);
      console.error("Error loading application data from local storage.  Using defaults.");
      return new AppData();
    }
  }

  public async initialize() {
    const resp = await fetch("/api/initialize");
    const data = await resp.json();
    this.models = data.models.map((d: any) => plainToInstance(Model, d));
    this.users = data.users.map((d: any) => plainToInstance(User, d));

    // get user form local storage
    this.chats = [];
    const find = this.user;
    await this.changeUser(null);
    if (find != null) {
      for (const user of this.users) {
        if (user.id == find.id) {
          await this.changeUser(user); 
        }
      }
    }

    this.publish();
  }

  public async import(data: any) {
    const chat = plainToInstance(Chat, data);
    chat.id = uuidv4()
    chat.user_id = null;
    this.openChat(chat);
    this.unsavedChat = null;
    this.dirty();
  }


  public dirty(saveNow = false) {
    if (this._dirtySave) {
      clearTimeout(this._dirtySave);
      this._dirtySave = null;
    }
    this._dirtySave = setTimeout(() => {
      this._doSave();
    }, saveNow ? 1 : 1500);
  }

  public isSaved() {
    if (!this.currentChat) {
      return false;
    }
    if (!this.user) {
      return false;
    }
    if (!this.currentChat.id) {
      return false;
    }
    if (this.currentChat.user_id != this.user.id) {
      return false;
    }
    if (!this.currentChat.loaded) {
      return false;
    }
    return true;
  }

  private async _doSave() {
    console.log("Saving to local storage");
    let chatToSave = this.currentChat;
    if (this.isSaved() && this.unsavedChat) {
      chatToSave = this.unsavedChat;
    }
    const serialize = new LocalSaveInfo();
    serialize.chat = chatToSave;
    serialize.user = this.user;
    serialize.version = 3;
    localStorage.setItem("appData", JSON.stringify(instanceToPlain(serialize)));

    if (this.isSaved()) {
        console.log("Sending chat update to server");
        this.currentChat.temporary_name = this.currentChat.label();
        await fetch("/api/chat", {
          body: JSON.stringify(instanceToPlain(this.currentChat)),
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
        });
    }
  }
}