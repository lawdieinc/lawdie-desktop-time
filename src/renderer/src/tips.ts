/* Tooltips. Each control keeps its help text in `title`. This shows that text at once, on hover and on keyboard
   focus, in the .tip-bubble style (styles.css). While a tooltip shows, the text moves from `title` to `data-tip`,
   so the browser does not show its own slow tooltip on top; it goes back to `title` after. */

export function installTips(): void {
    const marked = window as unknown as { lawdieTips?: boolean };
    if (marked.lawdieTips) return;
    marked.lawdieTips = true;

    const bubble = document.createElement("div");
    bubble.className = "tip-bubble";
    bubble.id = "tip-bubble";
    bubble.setAttribute("role", "tooltip");
    let owner: Element | null = null;
    let moved = false;

    const place = (el: Element): void => {
        const box = el.getBoundingClientRect();
        const gap = 8;
        const width = bubble.offsetWidth;
        const height = bubble.offsetHeight;
        let left = box.left + box.width / 2 - width / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
        let top = box.bottom + gap;
        if (top + height > window.innerHeight - 8 && box.top - gap - height >= 8) top = box.top - gap - height;
        bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };

    const hide = (): void => {
        if (!owner) return;
        // A page can set a new `title` while the tooltip shows (React does on a re-render). The new text stays.
        const tip = owner.getAttribute("data-tip");
        if (moved && tip !== null) {
            if (!owner.hasAttribute("title")) owner.setAttribute("title", tip);
            owner.removeAttribute("data-tip");
        }
        if (owner.getAttribute("aria-describedby") === "tip-bubble") owner.removeAttribute("aria-describedby");
        owner = null;
        moved = false;
        bubble.classList.remove("on");
    };

    const show = (el: Element): void => {
        if (el === owner) return;
        hide();
        const text = el.getAttribute("data-tip") || el.getAttribute("title");
        if (!text) return;
        owner = el;
        if (el.hasAttribute("title")) {
            el.setAttribute("data-tip", text);
            el.removeAttribute("title");
            moved = true;
        }
        if (!el.hasAttribute("aria-describedby")) el.setAttribute("aria-describedby", "tip-bubble");
        bubble.textContent = text;
        if (!bubble.isConnected) document.body.appendChild(bubble);
        place(el);
        bubble.classList.add("on");
    };

    const find = (target: EventTarget | null): Element | null => (target instanceof Element ? target.closest("[title],[data-tip]") : null);
    document.addEventListener("mouseover", (e) => { const el = find(e.target); if (el) show(el); else hide(); });
    document.addEventListener("mouseout", (e) => { if (owner && !(e.relatedTarget instanceof Node && owner.contains(e.relatedTarget))) hide(); });
    document.addEventListener("focusin", (e) => { const el = find(e.target); if (el) show(el); });
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", hide);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
}
