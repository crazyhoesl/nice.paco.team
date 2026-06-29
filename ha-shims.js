// ha-shims.js
// Minimal Home-Assistant shims so the Helios card renders inside a plain web
// page (i.e. outside Home Assistant). Two jobs:
//
//   1. Define the two HA custom elements the card expects to exist:
//        <ha-card>  a slotted surface (the card styles it from its own shadow
//                   CSS, so the shim only has to expose the children via a slot)
//        <ha-icon>  delegates "mdi:*" names to <iconify-icon> (registered by the
//                   Iconify CDN script in index.html), sized from --mdc-icon-size
//
//   2. Inject the HA design tokens the card reads for colours, fonts, spacing.
//      Light values on :root; dark overrides under .theme-dark, which demo-mount
//      toggles on <body> together with the card's own dark recipe.

function defineSafely(name, ctor)
{
    if (!customElements.get(name))
    {
        customElements.define(name, ctor);
    }
}

class HeliosShimHaCard extends HTMLElement
{
    constructor()
    {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host {
                    display: block;
                    position: relative;
                    height: 100%;
                    width: 100%;
                }
            </style>
            <slot></slot>
        `;
    }
}

class HeliosShimHaIcon extends HTMLElement
{
    static get observedAttributes() { return ['icon']; }

    constructor()
    {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width:  var(--mdc-icon-size, 24px);
                    height: var(--mdc-icon-size, 24px);
                    color: inherit;
                    vertical-align: middle;
                }
                iconify-icon {
                    display: inline-flex;
                    font-size: var(--mdc-icon-size, 24px);
                    line-height: 1;
                    color: inherit;
                }
            </style>
            <iconify-icon></iconify-icon>
        `;
        this._iconEl = root.querySelector('iconify-icon');
    }

    connectedCallback() { this._sync(); }
    attributeChangedCallback() { this._sync(); }

    _sync()
    {
        if (!this._iconEl) return;
        this._iconEl.setAttribute('icon', this.getAttribute('icon') || '');
    }
}

defineSafely('ha-card', HeliosShimHaCard);
defineSafely('ha-icon', HeliosShimHaIcon);

(function injectHaTokens()
{
    if (document.getElementById('helios-ha-tokens')) return;
    const style = document.createElement('style');
    style.id = 'helios-ha-tokens';
    style.textContent = `
        :root {
            --card-background-color: #ffffff;
            --ha-card-background: #ffffff;
            --primary-background-color: #fafafa;
            --secondary-background-color: #e5e5e5;

            --primary-text-color: #212121;
            --rgb-primary-text-color: 33, 33, 33;
            --secondary-text-color: #727272;

            --primary-color: #03a9f4;
            --rgb-primary-color: 3, 169, 244;
            --dark-primary-color: #0288d1;
            --darker-primary-color: #01579b;
            --text-on-primary-color: #ffffff;
            --text-primary-color: #ffffff;

            --divider-color: rgba(0, 0, 0, 0.12);
            --ha-card-border-color: rgba(0, 0, 0, 0.12);
            --ha-card-border-radius: 12px;
            --shadow-color: rgba(0, 0, 0, 0.3);
            --mdc-icon-size: 24px;

            --energy-solar-color: #ff9800;
            --energy-grid-consumption-color: #488fc2;
            --energy-grid-return-color: #8353d1;
            --energy-battery-in-color: #f06292;
            --energy-battery-out-color: #4db6ac;
            --helios-consumption-color: #4caf50;

            --amber-color: #ffc107;
            --warning-color: #ffa600;
            --red-color: #f44336;
            --green-color: #4caf50;
            --grey-color: #9e9e9e;
            --blue-color: #2196f3;
            --success-color: #2e7d32;
            --error-color: #c62828;

            --ha-font-family-body: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        }

        body.theme-dark, :root.theme-dark {
            --card-background-color: #1c1c1c;
            --ha-card-background: #1c1c1c;
            --primary-background-color: #111111;
            --secondary-background-color: #202020;

            --primary-text-color: #e1e1e1;
            --rgb-primary-text-color: 225, 225, 225;
            --secondary-text-color: #9b9b9b;

            --divider-color: rgba(225, 225, 225, 0.12);
            --ha-card-border-color: rgba(225, 225, 225, 0.12);
            --shadow-color: rgba(0, 0, 0, 0.6);
        }
    `;
    (document.head || document.documentElement).appendChild(style);
})();
