/**
 * The only way the app builds DOM. Text is always set through `textContent`
 * and attributes through `setAttribute` against an allowlist, so a torrent
 * name, tracker message or peer client string can never become markup.
 *
 * Props:
 * - `text`: textContent.
 * - `class`: a string, or an array of strings with falsy entries skipped.
 * - `on`: `{ click: fn, ... }`, wired with `addEventListener`.
 * - `style`: `{ "--qb-x": "1px", width: "2px" }`, applied with `setProperty`.
 * - `value`, `checked`, `disabled`, `selected`, `hidden`, `indeterminate`,
 *   `multiple`, `readOnly`, `required`: set as properties, after the children.
 * - `aria-*`, `data-*` and the attributes in `HTML_ATTRS`: set as attributes.
 *   `null`, `undefined` and `false` skip the attribute; `true` sets it empty.
 * Anything else throws, including every `on*` attribute string.
 */

const HTML_ATTRS = new Set([
  'id', 'role', 'tabindex', 'type', 'name', 'placeholder', 'for', 'href',
  'download', 'autocomplete', 'inputmode', 'min', 'max', 'step', 'maxlength',
  'minlength', 'pattern', 'spellcheck', 'draggable', 'accept', 'rows', 'cols',
  'colspan', 'rowspan', 'scope', 'lang', 'dir', 'width', 'height', 'form',
  'list', 'enterkeyhint', 'autofocus', 'open', 'size', 'wrap', 'inert',
]);

const SVG_ATTRS = new Set([
  'viewBox', 'd', 'fill', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'width', 'height', 'points', 'transform', 'focusable', 'role',
  'preserveAspectRatio', 'id', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform',
]);

const PROPS = new Set([
  'value', 'checked', 'disabled', 'selected', 'hidden', 'indeterminate',
  'multiple', 'readOnly', 'required',
]);

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A scheme in an `href` is refused unless it is a same-origin `blob:` URL. */
function safeHref(value) {
  const v = String(value);
  if (/^\s*[a-z][a-z0-9+.-]*:/i.test(v) && !/^blob:/i.test(v)) {
    throw new TypeError(`el: refused href scheme in "${v.slice(0, 40)}"`);
  }
  return v;
}

function classString(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
}

function applyProps(node, props, attrs) {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') {
      node.textContent = value == null ? '' : String(value);
    } else if (key === 'class') {
      if (value) node.setAttribute('class', classString(value));
    } else if (key === 'on') {
      for (const [type, fn] of Object.entries(value || {})) {
        if (typeof fn !== 'function') throw new TypeError(`el: on.${type} is not a function`);
        node.addEventListener(type, fn);
      }
    } else if (key === 'style') {
      if (value === null || typeof value !== 'object') {
        throw new TypeError('el: style must be an object');
      }
      for (const [prop, v] of Object.entries(value)) {
        if (v != null) node.style.setProperty(prop, String(v));
      }
    } else if (/^on/i.test(key)) {
      throw new TypeError(`el: refused handler attribute "${key}"`);
    } else if (PROPS.has(key) && attrs === HTML_ATTRS) {
      continue;
    } else if (attrs.has(key) || /^(aria|data)-[a-z0-9-]+$/.test(key)) {
      if (value == null || value === false) continue;
      const v = value === true ? '' : key === 'href' ? safeHref(value) : String(value);
      node.setAttribute(key, v);
    } else {
      throw new TypeError(`el: refused property "${key}"`);
    }
  }
}

function append(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (typeof child === 'object') node.append(child);
    else node.append(String(child));
  }
}

/**
 * Build an HTML element.
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {Array<Node|string|number|null|undefined|false>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const p = props || {};
  applyProps(node, p, HTML_ATTRS);
  append(node, Array.isArray(children) ? children : [children]);
  // After the children, so a <select> value finds its <option>.
  for (const key of PROPS) if (key in p) node[key] = p[key];
  return node;
}

/**
 * Build an SVG element in the SVG namespace (icons, meters, sparklines).
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {Array<Node|null|undefined|false>} [children]
 * @returns {SVGElement}
 */
export function svg(tag, props = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props || {}, SVG_ATTRS);
  append(node, Array.isArray(children) ? children : [children]);
  return node;
}

/**
 * Replace every child of `node` with `children` (none clears it).
 * @param {Element} node
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {Element}
 */
export function clear(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}
