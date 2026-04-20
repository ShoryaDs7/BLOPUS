---
name: website
description: Use this skill when the user wants to build a website, landing page, portfolio, or any web page. Produces professional, modern websites using Tailwind CSS + GSAP animations. No npm, no build step, works instantly in browser.
---

# Website Builder

## Stack
Tailwind CDN + Alpine.js CDN + GSAP 3.15 CDN (ScrollTrigger+TextPlugin free) + Google Fonts. Single HTML file, save to `{BLOPUS_DIR}/output/website/index.html`.

## Rule #1 — Structure
**Never use a fixed section order.** Read what the user wants and build exactly that. If they say "portfolio" don't add pricing. If they say "restaurant" don't add a features grid. Match the website type. When unsure, use the Industry Guide below.

## Base Template (always use these exact CDNs + CSS + GSAP script)
```html
<!DOCTYPE html><html lang="en" class="scroll-smooth"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>PAGE TITLE</title><link rel="preconnect" href="https://fonts.googleapis.com"/><link href="https://fonts.googleapis.com/css2?family=FONT_CHOICE&display=swap" rel="stylesheet"/><script src="https://cdn.tailwindcss.com"></script><script>tailwind.config={theme:{extend:{fontFamily:{sans:['FONT','sans-serif'],display:['DISPLAY_FONT','sans-serif']},animation:{'float':'float 6s ease-in-out infinite','gradient':'gradient 8s ease infinite','pulse-slow':'pulse 4s cubic-bezier(0.4,0,0.6,1) infinite'},keyframes:{float:{'0%,100%':{transform:'translateY(0px)'},'50%':{transform:'translateY(-20px)'}},gradient:{'0%,100%':{backgroundPosition:'0% 50%'},'50%':{backgroundPosition:'100% 50%'}}}}}}</script><script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script><script src="https://cdn.jsdelivr.net/npm/gsap@3.15/dist/gsap.min.js"></script><script src="https://cdn.jsdelivr.net/npm/gsap@3.15/dist/ScrollTrigger.min.js"></script><script src="https://cdn.jsdelivr.net/npm/gsap@3.15/dist/TextPlugin.min.js"></script><style>body{font-family:'FONT',sans-serif;}.gradient-text{background:linear-gradient(135deg,VAR_COLOR1 0%,VAR_COLOR2 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}.gradient-bg{background:linear-gradient(135deg,VAR_COLOR1 0%,VAR_COLOR2 100%);background-size:200% 200%;}.glass{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1);}.glow{box-shadow:0 0 40px rgba(VAR_GLOW,0.4);}.card-hover{transition:all 0.3s ease;}.card-hover:hover{transform:translateY(-8px);box-shadow:0 20px 60px rgba(0,0,0,0.3);}body::before{content:'';position:fixed;top:0;left:0;width:100%;height:100%;opacity:0.03;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");pointer-events:none;z-index:9999;}</style></head>
<body class="bg-[BG_COLOR] text-white" x-data="{mobileMenu:false}">

<!-- SECTIONS HERE — based on user request + industry guide -->

<script>
gsap.registerPlugin(ScrollTrigger,TextPlugin);
gsap.set(['.hero-badge','.hero-title','.hero-sub','.hero-cta','.hero-stats'],{autoAlpha:0,y:30});
gsap.timeline({defaults:{ease:'power3.out'}}).to('.hero-badge',{autoAlpha:1,y:0,duration:0.6}).to('.hero-title',{autoAlpha:1,y:0,duration:0.9},'-=0.3').to('.hero-sub',{autoAlpha:1,y:0,duration:0.7},'-=0.4').to('.hero-cta',{autoAlpha:1,y:0,duration:0.6},'-=0.3').to('.hero-stats',{autoAlpha:1,y:0,duration:0.6},'-=0.2');
document.querySelectorAll('.count-up').forEach(el=>{const o={v:0};gsap.to(o,{v:+el.dataset.target,duration:2,delay:1,ease:'power2.out',onUpdate(){el.textContent=Math.floor(o.v).toLocaleString();}});});
gsap.utils.toArray('.section-heading').forEach(el=>gsap.from(el,{scrollTrigger:{trigger:el,start:'top 85%',once:true},autoAlpha:0,y:40,duration:0.8,ease:'power2.out'}));
gsap.utils.toArray('.card-group').forEach(g=>gsap.from(g.querySelectorAll('.gsap-card'),{scrollTrigger:{trigger:g,start:'top 80%',once:true},autoAlpha:0,y:50,duration:0.7,ease:'power2.out',stagger:{each:0.15,from:'start'}}));
gsap.utils.toArray('.pricing-card').forEach((c,i)=>gsap.from(c,{scrollTrigger:{trigger:c,start:'top 85%',once:true},autoAlpha:0,y:40,duration:0.7,ease:'back.out(1.7)',delay:i*0.15}));
gsap.utils.toArray('.testimonial-card').forEach((c,i)=>gsap.from(c,{scrollTrigger:{trigger:c,start:'top 85%',once:true},autoAlpha:0,y:30,duration:0.6,ease:'power2.out',delay:i*0.1}));
gsap.utils.toArray('.orb').forEach((o,i)=>gsap.to(o,{scrollTrigger:{trigger:'body',start:'top top',end:'bottom bottom',scrub:1},y:i%2===0?-150:150,ease:'none'}));
</script>
</body></html>
```

## Unsplash Images
Use real images via `https://images.unsplash.com/photo-PHOTO_ID?w=800&q=80&fit=crop` — always use relevant IDs per industry below. For `<img>` use `object-cover w-full h-full`. For bg use `style="background-image:url(...);background-size:cover"`.

## Industry Guide — design + sections + images per type

**SaaS / AI Tool** → bg `#0a0a0a`, colors `#667eea→#764ba2`, fonts Inter+Plus Jakarta Sans, style glassmorphism dark | sections: hero(headline+subtext+CTA+stats) → features grid → how-it-works steps → pricing tiers → testimonials → CTA banner → footer | images: abstract tech/code `1181671` `574077` `373543` — use as subtle hero bg or feature illustrations

**Fintech / Finance** → bg `#0d1117`, colors `#2563eb→#1d4ed8`, fonts IBM Plex Sans, style minimal data-dense professional | sections: hero(trust-focused headline+badges) → KPI stats row → features → security/compliance badges → testimonials → pricing → footer | images: business/finance `6801648` `669610` `3943716` — trading screens, city skylines, professional meetings

**Health / Medical / Wellness** → bg `#0d1a1a`, colors `#10b981→#059669`, fonts Figtree+Noto Sans, style clean soft accessible | sections: hero(empathy headline+CTA) → trust badges/certifications → services/features → testimonials → FAQ → contact/booking → footer | images: wellness/health `3822622` `1640770` `4386431` — nature, calm people, medical clean

**E-commerce / Product** → bg `#0a0a0a`, colors vibrant brand accent, fonts Rubik+Nunito Sans, style visual-heavy high-contrast | sections: hero(product visual+offer) → product showcase grid → features/benefits → social proof/ratings → comparison table → CTA → footer | images: product/lifestyle `1598515` `1598452` `3962285` — use as product card backgrounds or hero visual

**Portfolio / Creative / Agency** → bg `#0a0a0a`, bold accent color, fonts Syne+Manrope, style editorial storytelling | sections: hero(name+role+tagline) → work/projects grid → about/story → skills/services → testimonials → contact → footer | images: creative/design work `1779487` `196644` `3184291` — use as project mockup cards in work grid

**Education / Course** → bg `#0f0f23`, colors `#7c3aed→#4f46e5`, fonts Space Grotesk+DM Sans, style engaging progressive | sections: hero(outcome promise+social proof) → what you'll learn → curriculum/modules → instructor → testimonials → pricing → FAQ → enroll CTA → footer | images: learning/study `4144923` `3769021` `5905492` — students, notebooks, laptops

**Startup / General** → bg `#0a0a0a`, colors from brand, fonts Space Grotesk+DM Sans, style hero-centric minimal | sections: hero → 3 key benefits → how it works → social proof → CTA → footer | images: team/office `3184418` `1181406` `3182812` — team collaboration, modern workspace

**Food / Restaurant** → bg `#1a0a00`, colors warm `#f59e0b→#ef4444`, fonts Rubik+Nunito Sans, style visual-heavy appetite-first | sections: hero(full-bleed food image+tagline) → menu highlights → story/about → gallery grid → reservations/order CTA → reviews → footer | images: food `1640777` `299347` `1279330` `718742` `769289` — hero needs full-bleed food photo, gallery needs 6+ food images

**Real Estate** → bg `#0f1623`, colors `#0ea5e9→#0284c7`, fonts clean professional sans-serif, style trust-authority visual | sections: hero(location+value prop) → property grid/listings → why choose us → agent profiles → testimonials → contact/map → footer | images: property/architecture `1396122` `323780` `1029599` — use as property listing cards, hero background

## GSAP Classes
`hero-badge` `hero-title` `hero-sub` `hero-cta` `hero-stats` → hero sequence (set these on hero elements)
`count-up` + `data-target="N"` → animated counter on any stat span
`section-heading` → fade up on scroll | `card-group`+`gsap-card` → stagger cards | `pricing-card` → back.out | `testimonial-card` → stagger | `orb` → parallax bg blur

## Easing
`power2.out` default | `power3.out` headlines | `back.out(1.7)` pricing | `none` parallax

## CSS Utilities available
`gradient-text` `gradient-bg` `glass` `glow` `card-hover` `animate-pulse-slow` `animate-float` `animate-gradient`

## Image Usage Rules
Only place images in these specific ways — never randomly:
- **Hero bg**: `<section style="background-image:url(https://images.unsplash.com/photo-ID?w=1600&q=80&fit=crop);background-size:cover;background-position:center">` + dark overlay div `class="absolute inset-0 bg-black/60"` so text stays readable
- **Card/grid image**: `<img src="https://images.unsplash.com/photo-ID?w=800&q=80&fit=crop" class="w-full h-48 object-cover rounded-xl mb-4">`
- **Profile/avatar**: `<img src="..." class="w-16 h-16 rounded-full object-cover">`
- **Gallery grid**: CSS grid of `<img>` with `object-cover h-64 w-full rounded-2xl`
- **Never**: floating images with no container, images without `object-cover`, images as decoration without purpose
- Use industry photo IDs from industry guide — pick the most relevant one per placement

## Rules
1. Save to `{BLOPUS_DIR}/output/website/index.html`
2. Build sections the user asked for — don't add sections they didn't ask for
3. Use industry guide when type is clear; use Startup/General when unclear
4. Never lorem ipsum — write real content
5. Apply GSAP classes to every relevant element
6. `count-up`+`data-target` on every stat number
7. Single HTML file, mobile responsive via `md:` prefixes
8. After save: tell owner to open `{BLOPUS_DIR}/output/website/index.html`
