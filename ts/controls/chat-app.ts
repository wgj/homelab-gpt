import {LitElement, html, css} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';
import {repeat} from 'lit/directives/repeat.js';
import { AppData, Message, Model } from '../app-data.js';
import {appContext} from '../app-context.js'
import {provide} from '@lit-labs/context';
import { ChatContainer } from './chat-container.js';
import { ChatButton } from './chat-button.js';
import { ChatTextArea } from './chat-text-area.js';
import { ChatToggle } from './chat-toggle.js';
import { ChatSlider } from './chat-slider.js';
import { ChatMessage } from './chat-message.js';
import { ChatRadio } from './chat-radio.js';
import { v4 as uuidv4 } from 'uuid';
import { defaultCSS } from "../global-styles"
import { ChatIcon } from './chat-icon.js';
import { mdiChatQuestionOutline, mdiNuke } from '@mdi/js';

@customElement('chat-app')
export class ChatApp extends LitElement {

  @provide({context: appContext})
  @property({type: Object})
  app = new AppData();

  static override styles = [defaultCSS, css`
      :host {
        width: 100%;
      }

      /* vertically oriented flex box with a max width of 500px */
      .chat-log {
        display: flex;
        flex-direction: column;
        width: 100%;
      }

      /* an animated spinning progress indicator*/
      .loader {
        border: 6px solid #f3f3f3; /* Light grey */
        border-top: 6px solid #3498db; /* Blue */
        border-radius: 50%;
        width: 10px;
        height: 10px;
        animation: spin 1.5s linear infinite;
        display: inline-block;
        margin-right: 5px;
      }

      @keyframes spin {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
      }

      h1,
      h2,
      h3 {
        font-weight: 300;
        margin-top: 0;
        margin-bottom: 5px;
      }

      header {
        background-color: #222222;
        padding: 20px;
        box-shadow: 0 2px 5px 0 rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
      }

      .logo {
        color: #ffffff;
        font-size: 24px;
        text-decoration: none;
      }

      nav {
        display: flex;
      }

      nav a {
        color: #ffffff;
        text-decoration: none;
        margin-left: 15px;
      }

      nav a:hover {
        color: #f1c40f;
      }

      .buttons {
        justify-content: center;
        display: flex;
      }

      .button-icon {
        margin-right: 5px;
      }
  `];

  @query('#chat-input')
  _chatInput: ChatTextArea;

  @query('#system-input')
  _systemInput: ChatTextArea;

  @query('#model-select')
  _modelSelect: ChatRadio;

  @query('#stream')
  _stream: ChatToggle;

  @query('#determinism')
  _determinism: ChatSlider;

  @query('#max-tokens')
  _maxTokens: ChatSlider;

  public helper() {
    ChatMessage.properties;
    ChatSlider.properties;
    ChatTextArea.properties;
    ChatToggle.properties;
    ChatContainer.properties;
    ChatButton.properties;
    ChatRadio.properties;
    ChatIcon.properties;
  }

  override render() {
    return html`
      <header>
        <h1>AI Chat</h1>
      </header>
      <chat-container>
        <div class="wide">
          <h3>Prompt</h3>
          <chat-text-area
            placeholder="You can enter anything here, its instructions about what the AI should be.  The default is to be a helpful assistant."
            id="system-input"
            rows="2"
          ></chat-text-area>
        </div>
      </chat-container>
      <chat-container>
          <chat-radio id="model-select" .options=${this.app.models} .value=${this.app.getCurrentModel()} @input=${this._updateSelectedModel}></chat-radio>
          <chat-toggle id="stream" label="Stream" ?value=${true}></chat-toggle>
          <chat-slider
            label="Determinism {}%"
            id="determinism"
            min="0"
            max="100"
            step="1"
            value="50"
          ></chat-slider>
          <chat-slider
            label="Max Tokens {}"
            id="max-tokens"
            min="25"
            max=${this.app.getCurrentModel().maxTokens}
            step="25"
            value="1000"
          ></chat-slider>
        </div>
      </chat-container>
      <chat-container>
        <div class="flex-veritcal wide">
          ${repeat(this.app.messages, (msg) => msg.id, (msg, _index) => html`
            <chat-message class="wide" .message=${msg} @delete=${this._messageDelete} @replay=${this._messageReplay} @continue=${this._messageContinue}></chat-message>
          `)}
        </div>
      </chat-container>
      <chat-container>
        <div class="wide">
          <chat-text-area
            class="chat-input"
            rows="4"
            placeholder="Start the conversation here"
            id="chat-input"
            @submit=${this._chat}
          ></chat-text-area>
        </div>
      </chat-container>
      <chat-container>
        <div class="buttons">
          ${this.app.busy ?
            html`
            <chat-button id="cancel" class="hidden button" @click=${this._cancel}>
              <div class="loader"></div>
              <span> Cancel </span>
            </chat-button>` :
            html`
            <chat-button id="submit" @click=${this._chat}>
              <div class="flex-horizontal flex-center">
                <chat-icon class="button-icon" .path=${mdiChatQuestionOutline}></chat-icon>
                <span>Submit </span>
              </div>
            </chat-button>`}
          <chat-button id="clear_chat" ?danger=${true} @click=${this._clear}>
            <div class="flex-horizontal flex-center">
              <chat-icon class="button-icon" .path=${mdiNuke}></chat-icon>
              <span>Clear Chat</span>
            </div>
          </chat-button>
        </div>
      </chat-container>
    `;
  }

  override async firstUpdated() {
    await this.updateComplete;
    this._chatInput.doFocus();
    this.app.bindToUpdates(() => this.requestUpdate());
  }

  private async _chat() {
    this._addChatRequest();
    try {
      this.requestUpdate();
      const modelName = (this._modelSelect.value as Model).value
      if (this._stream) {
        await this.app.chatStream(this._systemInput.value, modelName, this._determinism.value, this._maxTokens.value);
      } else {
        await this.app.chatSynchronous(this._systemInput.value, modelName, this._determinism.value, this._maxTokens.value);
      }
    } finally {
      this.requestUpdate();
    }
  }

  private _updateSelectedModel() {
    this.app.currentModel = this._modelSelect.value as Model;
    if (this._maxTokens.value > this.app.getCurrentModel().maxTokens) {
      this._maxTokens.value = this.app.getCurrentModel().maxTokens;
    }
    this.requestUpdate();
  }

  private async _cancel() {
    await this.app.cancel();
    this.requestUpdate();
  }

  private async _clear() {
    this.app.messages.length = 0;
    this.requestUpdate();
    this._chatInput.doFocus();
  }

  private _addChatRequest() {
    if (this._chatInput.value.length > 0) {
      const message: Message = {
        role: 'user',
        id: uuidv4(),
        message: this._chatInput.value
      }
      this.app.messages.push(message);
      this._chatInput.value = '';
      this._chatInput.doFocus();
    }
  }

  private async _messageDelete(e: CustomEvent) {
    const message = e.detail as Message;
    await this.app.delete(message);
    this.requestUpdate();
  }

  private async _messageReplay(e: CustomEvent) {
    const message = e.detail as Message;
    this._chatInput.value = message.message;
    this.app.truncate(message);
    this.requestUpdate();
  }

  private async _messageContinue(e: CustomEvent) {
    const message = e.detail as Message;
    const modelName = (this._modelSelect.value as Model).value
    await this.app.continue(message, this._systemInput.value, modelName, this._determinism.value, this._maxTokens.value);
    this.requestUpdate();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-app': ChatApp;
  }
}
