---
name: website
description: Use this skill when the user wants to build a website, landing page, portfolio, or any web page. Produces professional, modern websites using Tailwind CSS + Aceternity-style animations. No npm, no build step, works instantly in browser.
---

# Website Builder Guide

## Stack — always use this, no exceptions
- **Tailwind CSS** via CDN — no install needed
- **Alpine.js** via CDN — lightweight interactivity (dropdowns, toggles, counters)
- **AOS (Animate On Scroll)** via CDN — scroll animations like Aceternity UI
- **Google Fonts** — Inter or Plus Jakarta Sans for clean modern look
- Pure HTML in a single file — opens instantly, no build step

## Always start with this base template
```html
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PAGE TITLE</title>

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

  <!-- Tailwind CSS -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['Inter', 'sans-serif'], display: ['Plus Jakarta Sans', 'sans-serif'] },
          animation: {
            'fade-up': 'fadeUp 0.6s ease-out forwards',
            'fade-in': 'fadeIn 0.8s ease-out forwards',
            'float': 'float 6s ease-in-out infinite',
            'gradient': 'gradient 8s ease infinite',
            'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          },
          keyframes: {
            fadeUp: { '0%': { opacity: '0', transform: 'translateY(30px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
            fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
            float: { '0%, 100%': { transform: 'translateY(0px)' }, '50%': { transform: 'translateY(-20px)' } },
            gradient: { '0%, 100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
          }
        }
      }
    }
  </script>

  <!-- Alpine.js -->
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>

  <!-- AOS Animations -->
  <link rel="stylesheet" href="https://unpkg.com/aos@2.3.4/dist/aos.css" />
  <script src="https://unpkg.com/aos@2.3.4/dist/aos.js"></script>

  <style>
    body { font-family: 'Inter', sans-serif; }
    .gradient-text {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .gradient-bg {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      background-size: 200% 200%;
    }
    .glass {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .glow {
      box-shadow: 0 0 40px rgba(102, 126, 234, 0.4);
    }
    .card-hover {
      transition: all 0.3s ease;
    }
    .card-hover:hover {
      transform: translateY(-8px);
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    /* Noise texture overlay */
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      opacity: 0.03;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: 9999;
    }
  </style>
</head>
<body class="bg-[#0a0a0a] text-white" x-data="{ mobileMenu: false }" x-init="AOS.init({ duration: 700, once: true, offset: 80 })">
  <!-- PAGE CONTENT HERE -->
</body>
</html>
```

---

## Components — copy and use as needed

### Navbar (sticky, glass effect)
```html
<nav class="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5">
  <div class="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
    <a href="#" class="text-xl font-bold font-display gradient-text">LOGO</a>
    <!-- Desktop links -->
    <div class="hidden md:flex items-center gap-8">
      <a href="#features" class="text-sm text-gray-400 hover:text-white transition-colors">Features</a>
      <a href="#pricing" class="text-sm text-gray-400 hover:text-white transition-colors">Pricing</a>
      <a href="#" class="bg-white text-black text-sm font-semibold px-5 py-2.5 rounded-full hover:bg-gray-100 transition-colors">Get Started</a>
    </div>
    <!-- Mobile hamburger -->
    <button @click="mobileMenu = !mobileMenu" class="md:hidden text-gray-400">
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
  </div>
  <!-- Mobile menu -->
  <div x-show="mobileMenu" x-transition class="md:hidden px-6 pb-4 flex flex-col gap-4">
    <a href="#features" class="text-gray-400 hover:text-white">Features</a>
    <a href="#pricing" class="text-gray-400 hover:text-white">Pricing</a>
    <a href="#" class="bg-white text-black text-sm font-semibold px-5 py-2.5 rounded-full text-center">Get Started</a>
  </div>
</nav>
```

### Hero Section (dark, animated gradient orbs)
```html
<section class="relative min-h-screen flex items-center justify-center overflow-hidden pt-20">
  <!-- Background orbs -->
  <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl animate-pulse-slow"></div>
  <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-3xl animate-pulse-slow" style="animation-delay: 2s"></div>

  <div class="relative z-10 max-w-5xl mx-auto px-6 text-center">
    <!-- Badge -->
    <div class="inline-flex items-center gap-2 glass rounded-full px-4 py-2 mb-8 text-sm text-gray-300 animate-fade-in">
      <span class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
      BADGE TEXT HERE
    </div>

    <!-- Headline -->
    <h1 class="text-5xl md:text-7xl font-black font-display mb-6 leading-tight animate-fade-up">
      Main Headline<br/>
      <span class="gradient-text">Gradient Part</span>
    </h1>

    <!-- Subheading -->
    <p class="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto mb-10 animate-fade-up" style="animation-delay: 0.2s">
      Subheading description goes here. Keep it short and punchy.
    </p>

    <!-- CTA Buttons -->
    <div class="flex flex-col sm:flex-row gap-4 justify-center animate-fade-up" style="animation-delay: 0.4s">
      <a href="#" class="gradient-bg text-white font-semibold px-8 py-4 rounded-full hover:opacity-90 transition-opacity glow animate-gradient">
        Primary CTA →
      </a>
      <a href="#" class="glass text-white font-semibold px-8 py-4 rounded-full hover:bg-white/10 transition-colors">
        Secondary CTA
      </a>
    </div>

    <!-- Social proof numbers -->
    <div class="flex flex-wrap justify-center gap-8 mt-16 animate-fade-up" style="animation-delay: 0.6s">
      <div class="text-center">
        <div class="text-3xl font-bold">10K+</div>
        <div class="text-sm text-gray-500 mt-1">Users</div>
      </div>
      <div class="w-px bg-white/10"></div>
      <div class="text-center">
        <div class="text-3xl font-bold">99%</div>
        <div class="text-sm text-gray-500 mt-1">Uptime</div>
      </div>
      <div class="w-px bg-white/10"></div>
      <div class="text-center">
        <div class="text-3xl font-bold">4.9★</div>
        <div class="text-sm text-gray-500 mt-1">Rating</div>
      </div>
    </div>
  </div>
</section>
```

### Features Grid (3 columns, cards with icons)
```html
<section id="features" class="py-24 px-6">
  <div class="max-w-7xl mx-auto">
    <div class="text-center mb-16" data-aos="fade-up">
      <p class="text-sm font-semibold text-purple-400 uppercase tracking-widest mb-3">Features</p>
      <h2 class="text-4xl md:text-5xl font-black font-display mb-4">Everything you need</h2>
      <p class="text-gray-400 max-w-xl mx-auto">Description of the features section.</p>
    </div>

    <div class="grid md:grid-cols-3 gap-6">
      <!-- Feature Card -->
      <div class="glass rounded-2xl p-8 card-hover" data-aos="fade-up" data-aos-delay="0">
        <div class="w-12 h-12 gradient-bg rounded-xl flex items-center justify-center mb-6">
          <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <h3 class="text-xl font-bold mb-3">Feature Title</h3>
        <p class="text-gray-400 leading-relaxed">Feature description goes here. Keep it concise and benefit-focused.</p>
      </div>

      <!-- Repeat cards with data-aos-delay="100", "200" etc -->
    </div>
  </div>
</section>
```

### Pricing Section (2-3 tiers)
```html
<section id="pricing" class="py-24 px-6">
  <div class="max-w-5xl mx-auto">
    <div class="text-center mb-16" data-aos="fade-up">
      <h2 class="text-4xl md:text-5xl font-black font-display mb-4">Simple pricing</h2>
      <p class="text-gray-400">No hidden fees. Cancel anytime.</p>
    </div>

    <div class="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
      <!-- Free tier -->
      <div class="glass rounded-2xl p-8" data-aos="fade-up">
        <h3 class="text-lg font-bold mb-2">Free</h3>
        <div class="text-4xl font-black mb-6">$0<span class="text-lg text-gray-400 font-normal">/mo</span></div>
        <ul class="space-y-3 mb-8">
          <li class="flex items-center gap-3 text-gray-300"><span class="text-green-400">✓</span> Feature one</li>
          <li class="flex items-center gap-3 text-gray-300"><span class="text-green-400">✓</span> Feature two</li>
          <li class="flex items-center gap-3 text-gray-500"><span class="text-gray-600">✗</span> Pro feature</li>
        </ul>
        <a href="#" class="block text-center glass border border-white/20 text-white font-semibold px-6 py-3 rounded-full hover:bg-white/10 transition-colors">Get started free</a>
      </div>

      <!-- Pro tier (highlighted) -->
      <div class="gradient-bg rounded-2xl p-8 glow" data-aos="fade-up" data-aos-delay="100">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-lg font-bold">Pro</h3>
          <span class="text-xs bg-white/20 px-3 py-1 rounded-full">Most Popular</span>
        </div>
        <div class="text-4xl font-black mb-6">$29<span class="text-lg font-normal opacity-70">/mo</span></div>
        <ul class="space-y-3 mb-8">
          <li class="flex items-center gap-3"><span class="text-white">✓</span> Everything in Free</li>
          <li class="flex items-center gap-3"><span class="text-white">✓</span> Pro feature one</li>
          <li class="flex items-center gap-3"><span class="text-white">✓</span> Pro feature two</li>
        </ul>
        <a href="#" class="block text-center bg-white text-black font-semibold px-6 py-3 rounded-full hover:bg-gray-100 transition-colors">Start free trial</a>
      </div>
    </div>
  </div>
</section>
```

### Testimonials
```html
<section class="py-24 px-6">
  <div class="max-w-7xl mx-auto">
    <h2 class="text-4xl font-black font-display text-center mb-16" data-aos="fade-up">What people say</h2>
    <div class="grid md:grid-cols-3 gap-6">
      <div class="glass rounded-2xl p-8 card-hover" data-aos="fade-up">
        <div class="flex gap-1 mb-4">★★★★★</div>
        <p class="text-gray-300 mb-6 leading-relaxed">"Quote goes here. Make it specific and credible."</p>
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 gradient-bg rounded-full flex items-center justify-center font-bold text-sm">JD</div>
          <div>
            <div class="font-semibold text-sm">John Doe</div>
            <div class="text-xs text-gray-500">CEO at Company</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
```

### Footer
```html
<footer class="border-t border-white/5 py-12 px-6">
  <div class="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
    <div class="font-bold text-xl gradient-text">LOGO</div>
    <p class="text-gray-500 text-sm">© 2026 Company. All rights reserved.</p>
    <div class="flex gap-6">
      <a href="#" class="text-sm text-gray-500 hover:text-white transition-colors">Privacy</a>
      <a href="#" class="text-sm text-gray-500 hover:text-white transition-colors">Terms</a>
      <a href="#" class="text-sm text-gray-500 hover:text-white transition-colors">Contact</a>
    </div>
  </div>
</footer>
```

---

## Rules — follow every time
1. Always save to `C:/Blopus/output/website/index.html` (create folder if needed)
2. Always use dark background `#0a0a0a` — never white background unless owner asks
3. Always use gradient-text for brand name and key headlines
4. Always use glass cards for features and testimonials
5. Always add AOS `data-aos="fade-up"` to every section heading and card
6. Always use animate-pulse-slow orbs in hero background
7. Never use placeholder lorem ipsum — generate real content based on what the user asks for
8. After saving, tell owner: "Open `C:/Blopus/output/website/index.html` in your browser"
9. Single HTML file only — no separate CSS/JS files needed
10. Mobile responsive by default using Tailwind responsive prefixes (md:, lg:)
