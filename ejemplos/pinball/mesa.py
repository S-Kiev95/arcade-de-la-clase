"""Física y reglas de Neon Pinball (sin pygame: se puede probar sin pantalla).

Unidades: píxeles de una mesa de 480 x 640 (y hacia abajo) y segundos. La bola se integra en subpasos
cortos para que no atraviese paredes ni flippers aunque vaya rápida.
"""
import math

W, H = 480, 640
R = 8                       # radio de la bola
G = 1150.0                  # gravedad de la mesa inclinada (px/s²)
VMAX = 1700.0
CARRIL_X0, CARRIL_X1, CARRIL_FONDO = 432, 463, 626


def mas_cercano(px, py, a, b):
    """Punto del segmento a-b más cercano a (px, py)."""
    abx, aby = b[0] - a[0], b[1] - a[1]
    t = ((px - a[0]) * abx + (py - a[1]) * aby) / ((abx * abx + aby * aby) or 1.0)
    t = max(0.0, min(1.0, t))
    return a[0] + abx * t, a[1] + aby * t


class Flipper:
    def __init__(self, pivote, largo, reposo, activo):
        self.p, self.largo = pivote, largo
        self.reposo, self.activo = math.radians(reposo), math.radians(activo)
        self.ang, self.w, self.pulsado = self.reposo, 0.0, False

    def punta(self):
        return self.p[0] + math.cos(self.ang) * self.largo, self.p[1] + math.sin(self.ang) * self.largo

    def mover(self, dt):
        objetivo = self.activo if self.pulsado else self.reposo
        vel = 22.0 if self.pulsado else 14.0                  # sube rápido, baja algo más despacio
        paso = max(-vel * dt, min(vel * dt, objetivo - self.ang))
        self.w = paso / dt if dt else 0.0
        self.ang += paso


class Bola:
    def __init__(self):
        self.x, self.y, self.vx, self.vy = 0.0, 0.0, 0.0, 0.0


def arco(cx, cy, r, a0, a1, n):
    pts = [(cx + r * math.cos(a0 + (a1 - a0) * k / n), cy + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]
    return list(zip(pts, pts[1:]))


class Mesa:
    def __init__(self):
        # paredes: (a, b, restitución)
        self.paredes = [((23, 260), (23, 470), 0.5), ((23, 470), (150, 553), 0.4),           # izquierda e inlane
                        ((CARRIL_X0, 200), (CARRIL_X0, CARRIL_FONDO), 0.5),                   # separador del carril
                        ((CARRIL_X0, 470), (330, 553), 0.4),                                  # inlane derecho
                        ((CARRIL_X1, 260), (CARRIL_X1, CARRIL_FONDO), 0.5),                   # exterior del carril
                        ((CARRIL_X0, CARRIL_FONDO), (CARRIL_X1, CARRIL_FONDO), 0.2)]          # tope del lanzador
        self.paredes += [(a, b, 0.55) for a, b in arco(243, 260, 220, math.pi, 2 * math.pi, 28)]
        self.bumpers = [[170.0, 235.0, 24.0, 0.0], [310.0, 235.0, 24.0, 0.0], [240.0, 325.0, 24.0, 0.0]]  # x, y, r, destello
        self.kickers = [[(72, 430), (122, 503), 0.0], [(408, 430), (358, 503), 0.0]]                # tirachinas
        self.dianas = [[(181, 148), (205, 138), False], [(229, 131), (251, 125), False], [(275, 138), (299, 148), False]]  # inclinadas: la bola no puede posarse
        self.flip_i = Flipper((150, 560), 74, 32, -28)
        self.flip_d = Flipper((330, 560), 74, 148, 208)
        self.bola = Bola()
        self.record = 0
        self.estado = "inicio"
        self.eventos = []          # sonidos/efectos para la capa de presentación
        self.mensaje, self.t_mensaje = "", 0.0
        self.nueva_partida(empezar=False)

    # ------------------------------------------------------------ partida
    def nueva_partida(self, empezar=True):
        self.puntos, self.bolas, self.mult = 0, 3, 1
        for d in self.dianas:
            d[2] = False
        self.estado = "jugando" if empezar else "inicio"
        self.preparar_bola()

    def preparar_bola(self, nueva=True):
        if nueva:
            self.salvada_usada = False            # la bola salvada solo se regala una vez por bola
        b = self.bola
        b.x, b.y, b.vx, b.vy = (CARRIL_X0 + CARRIL_X1) / 2, CARRIL_FONDO - R - 1, 0.0, 0.0
        self.carga, self.cargando, self.salvar = 0.0, False, 0.0

    def en_carril(self):
        b = self.bola
        return b.x > CARRIL_X0 and b.y > CARRIL_FONDO - 60

    def soltar_lanzador(self):
        if self.estado == "jugando" and self.en_carril():
            self.bola.vy = -(1120.0 + 580.0 * self.carga)             # hasta un toque corto saca la bola al tablero
            self.salvar = 0.0 if self.salvada_usada else 4.0   # bola salvada si se pierde enseguida
            self.eventos.append("lanzar")
        self.carga, self.cargando = 0.0, False

    def avisar(self, texto, segundos=2.0):
        self.mensaje, self.t_mensaje = texto, segundos

    def sumar(self, p):
        self.puntos += p * self.mult
        self.record = max(self.record, self.puntos)

    # ------------------------------------------------------------ simulación
    def actualizar(self, dt, sub=8):
        h = dt / sub
        for _ in range(sub):
            self.paso(h)
        if self.cargando:
            self.carga = min(1.0, self.carga + dt * 1.1)
        self.salvar = max(0.0, self.salvar - dt)
        self.t_mensaje = max(0.0, self.t_mensaje - dt)
        for x in self.bumpers:
            x[3] = max(0.0, x[3] - dt)
        for k in self.kickers:
            k[2] = max(0.0, k[2] - dt)

    def paso(self, h):
        self.flip_i.mover(h)
        self.flip_d.mover(h)
        if self.estado != "jugando":
            return
        b = self.bola
        b.vy += G * h
        v = math.hypot(b.vx, b.vy)
        if v > VMAX:
            b.vx, b.vy = b.vx * VMAX / v, b.vy * VMAX / v
        b.x += b.vx * h
        b.y += b.vy * h
        for a, c, e in self.paredes:
            self.choque(a, c, e)
        for k in self.kickers:
            if self.choque(k[0], k[1], 0.5, impulso=430.0) == 2:
                k[2] = 0.12
                self.sumar(10)
                self.eventos.append("kicker")
        for d in self.dianas:
            if self.choque(d[0], d[1], 0.6) and not d[2]:
                d[2] = True
                self.sumar(250)
                self.eventos.append("diana")
                if all(x[2] for x in self.dianas):              # las tres: bonus y sube el multiplicador
                    self.sumar(1500)
                    self.mult = min(5, self.mult + 1)
                    self.avisar(f"MULTIPLICADOR x{self.mult}")
                    for x in self.dianas:
                        x[2] = False
                    self.eventos.append("bonus")
        for bu in self.bumpers:
            self.choque_bumper(bu)
        for f in (self.flip_i, self.flip_d):
            self.choque_flipper(f)
        if b.y > H + 20:
            self.perder_bola()

    def choque(self, a, c, e, impulso=0.0):
        b = self.bola
        qx, qy = mas_cercano(b.x, b.y, a, c)
        dx, dy = b.x - qx, b.y - qy
        d2 = dx * dx + dy * dy
        if d2 >= R * R or d2 < 1e-9:
            return False
        d = math.sqrt(d2)
        nx, ny = dx / d, dy / d
        b.x, b.y = qx + nx * R, qy + ny * R
        vn = b.vx * nx + b.vy * ny
        if vn >= 0:
            return False
        tx, ty = -ny, nx
        vt = (b.vx * tx + b.vy * ty) * 0.995
        vn2 = -vn * e
        disparo = impulso and vn < -200              # el tirachinas solo salta si la bola llega con fuerza
        if disparo:
            vn2 = max(vn2, impulso)
        b.vx, b.vy = nx * vn2 + tx * vt, ny * vn2 + ty * vt
        return 2 if disparo else 1

    def choque_bumper(self, bu):
        b = self.bola
        dx, dy = b.x - bu[0], b.y - bu[1]
        rr = R + bu[2]
        d2 = dx * dx + dy * dy
        if d2 >= rr * rr or d2 < 1e-9:
            return
        d = math.sqrt(d2)
        nx, ny = dx / d, dy / d
        b.x, b.y = bu[0] + nx * rr, bu[1] + ny * rr
        vn = b.vx * nx + b.vy * ny
        if vn < 0:
            vn2 = max(-vn * 0.9, 680.0)
            b.vx += (vn2 - vn) * nx
            b.vy += (vn2 - vn) * ny
            bu[3] = 0.15
            self.sumar(100)
            self.eventos.append("bumper")

    def choque_flipper(self, f):
        b = self.bola
        a, c = f.p, f.punta()
        qx, qy = mas_cercano(b.x, b.y, a, c)
        dx, dy = b.x - qx, b.y - qy
        rr = R + 7
        d2 = dx * dx + dy * dy
        if d2 >= rr * rr or d2 < 1e-9:
            return
        d = math.sqrt(d2)
        nx, ny = dx / d, dy / d
        b.x, b.y = qx + nx * rr, qy + ny * rr
        vfx, vfy = -f.w * (qy - a[1]), f.w * (qx - a[0])         # velocidad del flipper en el punto de contacto
        rvx, rvy = b.vx - vfx, b.vy - vfy
        vn = rvx * nx + rvy * ny
        if vn < 0:
            b.vx -= 1.3 * vn * nx
            b.vy -= 1.3 * vn * ny

    def perder_bola(self):
        if self.salvar > 0:
            self.salvada_usada = True
            self.preparar_bola(nueva=False)
            self.avisar("¡BOLA SALVADA!")
            self.eventos.append("salvada")
            return
        self.bolas -= 1
        self.eventos.append("perdida")
        if self.bolas <= 0:
            self.estado = "fin"
        self.preparar_bola()
