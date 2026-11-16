/*
  dnvb.zieads.com: one page landing in the dnvbindonesia.com look (white, Plus Jakarta Sans, pink pill
  buttons, dark marquee band). Every call to action goes straight to the dashboard (sign in or sign up).
  Copy rule: no em dash, no en dash (CLAUDE.md).
*/
import './landing/dnvb/dnvb.css';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DnvbLogo from '../components/DnvbLogo';
import SocialIcon from '../components/v3/SocialIcon';
import { supabase } from '../lib/supabaseClient';

interface Props {
  onScanComplete?: (data: any) => void;
}

const WA = 'https://wa.me/6285293307880';

const FEATURES = [
  { n: '01', t: 'Satu tabel untuk 100+ akun', b: 'Followers, views 30 hari, video terbaru, antrean posting dan status token setiap akun dalam satu layar. Cari, filter per grup, urutkan, lalu ambil aksi massal.' },
  { n: '02', t: 'Connect link untuk kreator', b: 'Kirim satu link ke kreator atau tim toko. Mereka login TikTok di HP sendiri, akunnya langsung masuk ke workspace kamu. Tanpa bagi password.' },
  { n: '03', t: 'Jadwal massal, jeda otomatis', b: 'Satu video, puluhan akun. Pilih akun per grup, atur caption per akun, lalu sebar jadwalnya 2 sampai 60 menit antar akun supaya tidak terlihat seperti spam.' },
  { n: '04', t: 'Analytics gabungan dan per akun', b: 'Total followers dan views seluruh armada, tren 30 hari, akun yang paling cepat tumbuh, dan akun yang sudah 14 hari tidak posting.' },
  { n: '05', t: 'AI Analyst dan AI Agent', b: 'Zie membaca angka semua akun, memberi tahu apa yang berubah, lalu menyiapkan draft konten. Semua tetap draft sampai kamu setujui.' },
  { n: '06', t: 'Kalender dan alur review', b: 'Draft, review, approve, terjadwal, terbit. Tim konten dan approver bekerja di kalender yang sama untuk semua akun.' },
];

const STEPS = [
  { t: 'Masuk ke dashboard', b: 'Buat akun dnvb dengan email. Satu workspace bisa menampung ratusan akun TikTok.' },
  { t: 'Hubungkan akun TikTok', b: 'Tambah akun satu per satu lewat login resmi TikTok, atau sebar connect link ke kreator.' },
  { t: 'Kelompokkan dan jalankan', b: 'Beri label dan grup, jadwalkan konten massal, pantau performa dari satu tabel.' },
];

const FAQ = [
  { q: 'Berapa akun TikTok yang bisa saya hubungkan?', a: 'Satu workspace bisa menampung lebih dari 100 akun TikTok. Batasnya mengikuti paket: paket tertinggi tanpa batas.' },
  { q: 'Apakah saya perlu memberikan password TikTok?', a: 'Tidak. Semua akun terhubung lewat login resmi TikTok (OAuth). dnvb tidak pernah melihat password, dan akses bisa dicabut kapan saja dari TikTok atau dari dashboard.' },
  { q: 'Bagaimana menambah banyak akun dari satu browser?', a: 'Layar login TikTok selalu meminta memilih akun, jadi kamu bisa berganti akun di sana. Cara paling cepat untuk armada besar: buat connect link dan kirim ke tiap kreator.' },
  { q: 'Apakah video langsung terbit di TikTok?', a: 'Kalau izin Direct Post sudah aktif, video terbit otomatis sesuai jadwal. Sebelum itu, video masuk ke inbox TikTok akun tersebut sebagai draft dan pemilik akun tinggal menekan posting.' },
  { q: 'Data apa yang dibaca dari TikTok?', a: 'Profil, jumlah followers, likes, daftar video beserta views, likes, komentar dan share. Data disinkronkan otomatis beberapa kali sehari.' },
];

export default function LandingPage(_props: Props) {
  const navigate = useNavigate();
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState<number | null>(0);

  useEffect(() => {
    document.title = 'dnvb TikTok Hub: kelola 100+ akun TikTok dari satu dashboard';
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data?.session));
  }, []);

  const goDashboard = () => navigate(signedIn ? '/accounts' : '/sign-in', { state: { from: '/accounts' } });
  const goSignUp = () => navigate(signedIn ? '/accounts' : '/sign-up', { state: { from: '/accounts' } });

  return (
    <div className="dnl">
      <header className="dnl-nav">
        <div className="dnl-wrap dnl-nav-row">
          <Link to="/" aria-label="dnvb TikTok Hub, home">
            <DnvbLogo height={20} />
          </Link>
          <nav className="dnl-links" aria-label="Sections">
            <a href="#fitur">Fitur</a>
            <a href="#cara-kerja">Cara kerja</a>
            <a href="#faq">FAQ</a>
            <a href="https://dnvbindonesia.com" target="_blank" rel="noreferrer">
              DNVB Indonesia
            </a>
          </nav>
          <div className="dnl-nav-cta">
            {signedIn ? (
              <button type="button" className="dnl-pill" onClick={goDashboard}>
                Buka dashboard
              </button>
            ) : (
              <>
                <button type="button" className="dnl-text" onClick={goDashboard}>
                  Masuk
                </button>
                <button type="button" className="dnl-pill" onClick={goSignUp}>
                  Daftar
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="dnl-hero" id="top">
          <div className="dnl-wrap">
            <span className="dnl-badge">DNVB TIKTOK HUB</span>
            <h1>
              Satu dashboard untuk
              <br />
              100+ akun TikTok.
            </h1>
            <p className="dnl-lead">Hubungkan seluruh akun TikTok brand, toko dan kreator kamu. Jadwalkan konten massal, pantau performa setiap akun, dan biarkan AI menyiapkan langkah berikutnya.</p>
            <div className="dnl-hero-cta">
              <button type="button" className="dnl-pill is-lg" onClick={goDashboard}>
                Masuk ke dashboard <span aria-hidden="true">→</span>
              </button>
              <a className="dnl-pill is-lg is-ghost" href="#cara-kerja">
                Lihat cara kerja
              </a>
            </div>
            <HeroBoard />
          </div>
        </section>

        <div className="dnl-band" aria-hidden="true">
          <div className="dnl-band-track">
            {Array.from({ length: 2 }).map((_, k) => (
              <div className="dnl-band-set" key={k}>
                {['100+ akun TikTok', 'Satu workspace', 'Connect link kreator', 'Jadwal massal', 'Analytics gabungan', 'AI Analyst', 'Login resmi TikTok'].map((t) => (
                  <span key={t}>
                    <SocialIcon platform="tiktok" size={16} /> {t}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        <section className="dnl-sec" id="fitur">
          <div className="dnl-wrap">
            <span className="dnl-badge">FITUR</span>
            <h2>Dibuat untuk tim yang menjalankan banyak akun sekaligus.</h2>
            <p className="dnl-sub">Fungsi yang sama dengan ZieAds, difokuskan penuh untuk TikTok dan untuk skala armada akun.</p>
            <div className="dnl-grid">
              {FEATURES.map((f) => (
                <article className="dnl-card" key={f.n}>
                  <span className="dnl-num">{f.n}</span>
                  <h3>{f.t}</h3>
                  <p>{f.b}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="dnl-sec is-soft" id="cara-kerja">
          <div className="dnl-wrap">
            <span className="dnl-badge">CARA KERJA</span>
            <h2>Tiga langkah, lalu armada kamu berjalan.</h2>
            <ol className="dnl-steps">
              {STEPS.map((s, i) => (
                <li key={s.t}>
                  <span className="dnl-step-n">{i + 1}</span>
                  <h3>{s.t}</h3>
                  <p>{s.b}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="dnl-stats">
          <div className="dnl-wrap dnl-stats-row">
            <div>
              <strong>100+</strong>
              <span>akun TikTok per workspace</span>
            </div>
            <div>
              <strong>1 link</strong>
              <span>untuk mengundang kreator</span>
            </div>
            <div>
              <strong>Otomatis</strong>
              <span>sinkron data dan refresh token</span>
            </div>
          </div>
        </section>

        <section className="dnl-sec" id="faq">
          <div className="dnl-wrap dnl-narrow">
            <span className="dnl-badge">FAQ</span>
            <h2>Pertanyaan yang sering muncul</h2>
            <div className="dnl-faq">
              {FAQ.map((f, i) => (
                <div className={`dnl-faq-item ${open === i ? 'is-open' : ''}`} key={f.q}>
                  <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                    <span>{f.q}</span>
                    <span className="dnl-faq-icon" aria-hidden="true">
                      {open === i ? '−' : '+'}
                    </span>
                  </button>
                  {open === i && <p>{f.a}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="dnl-final">
          <div className="dnl-wrap">
            <h2>The floor is yours!</h2>
            <p>Masuk ke dashboard dan hubungkan akun TikTok pertama kamu dalam satu menit.</p>
            <div className="dnl-hero-cta">
              <button type="button" className="dnl-pill is-lg" onClick={goDashboard}>
                Masuk ke dashboard <span aria-hidden="true">→</span>
              </button>
              <a className="dnl-pill is-lg is-blue" href={WA} target="_blank" rel="noreferrer">
                Tanya via WhatsApp
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="dnl-foot">
        <div className="dnl-wrap dnl-foot-row">
          <div>
            <DnvbLogo height={18} tag={false} />
            <p>People-powered ed tech and media platform. TikTok Hub dijalankan dengan teknologi ZieAds.</p>
          </div>
          <nav aria-label="Footer">
            <Link to="/privacy-policy">Privacy Policy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/data-deletion">Data deletion</Link>
            <a href={WA} target="_blank" rel="noreferrer">
              We're one text away
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/* A drawn preview of the Accounts table, not a screenshot, so it stays sharp and honest (sample numbers). */
function HeroBoard() {
  const rows = [
    ['glowup.id', 'Skincare', '84.2K', '+1.2K', '1.4M'],
    ['skinlab.daily', 'Skincare', '51.9K', '+860', '920K'],
    ['ootd.jkt', 'Fashion', '39.4K', '+410', '610K'],
    ['dapur.mama', 'Food', '27.1K', '+95', '288K'],
    ['kopi.senja', 'Food', '12.6K', '-12', '74K'],
  ];
  return (
    <div className="dnl-board" aria-label="Contoh tampilan tabel akun TikTok, angka contoh">
      <div className="dnl-board-top">
        <span className="dnl-dot" />
        <span className="dnl-dot" />
        <span className="dnl-dot" />
        <span className="dnl-board-title">TikTok accounts · 128 akun</span>
      </div>
      <div className="dnl-board-stats">
        <div>
          <small>Total followers</small>
          <b>2.4M</b>
        </div>
        <div>
          <small>Views 30 hari</small>
          <b>38.1M</b>
        </div>
        <div>
          <small>Terjadwal</small>
          <b>214</b>
        </div>
        <div>
          <small>Perlu dicek</small>
          <b>3</b>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Akun</th>
            <th>Grup</th>
            <th>Followers</th>
            <th>7 hari</th>
            <th>Views 30d</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              <td>
                <span className="dnl-av">{r[0][0].toUpperCase()}</span>@{r[0]}
              </td>
              <td>
                <span className="dnl-chip">{r[1]}</span>
              </td>
              <td>{r[2]}</td>
              <td className={r[3].startsWith('-') ? 'is-down' : 'is-up'}>{r[3]}</td>
              <td>{r[4]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
