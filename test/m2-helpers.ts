import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, signup, uniq, type SignedUp } from './helpers.js';

export type Auth = { Authorization: string };

export interface Hotel {
  owner: SignedUp;
  manager: Auth;
  managerId: string;
  desk: Auth;
  deskId: string;
  typeId: string;
  rooms: { id: string; number: string }[];
}

/** Lagos calendar date, offset by `days`. */
export function lagosDay(days = 0): string {
  return new Date(Date.now() + 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

export async function login(app: INestApplication, email: string, password = 'Passw0rd!x'): Promise<Auth> {
  const res = await request(app.getHttpServer()).post(`${API}/auth/login`).send({ email, password }).expect(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

export async function addStaff(app: INestApplication, owner: Auth, role: 'MANAGER' | 'FRONT_DESK' | 'ACCOUNTANT' | 'HOUSEKEEPING') {
  const email = `${role.toLowerCase()}-${uniq()}@e2e.test`;
  const res = await request(app.getHttpServer())
    .post(`${API}/staff`)
    .set(owner)
    .send({ fullName: `Test ${role}`, email, phone: '+2348000000001', role, password: 'Passw0rd!x' })
    .expect(201);
  return { auth: await login(app, email), id: res.body.id as string };
}

/** A fresh Growth-trial hotel with one room type (with an hourly rate), rooms, a manager and a front-desk user. */
export async function setupHotel(app: INestApplication, roomCount = 3): Promise<Hotel> {
  const server = app.getHttpServer();
  const owner = await signup(app, 'Ops');
  const type = await request(server)
    .post(`${API}/room-types`)
    .set(owner.auth)
    .send({ name: `Standard ${uniq()}`, basePriceKobo: 5_000_000, hourlyPriceKobo: 1_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 })
    .expect(201);
  const rooms = (
    await request(server)
      .post(`${API}/rooms/bulk`)
      .set(owner.auth)
      .send({ roomTypeId: type.body.id, floor: 1, from: 101, to: 100 + roomCount })
      .expect(201)
  ).body.map((r: { id: string; number: string }) => ({ id: r.id, number: r.number }));
  const manager = await addStaff(app, owner.auth, 'MANAGER');
  const desk = await addStaff(app, owner.auth, 'FRONT_DESK');
  return { owner, manager: manager.auth, managerId: manager.id, desk: desk.auth, deskId: desk.id, typeId: type.body.id, rooms };
}

let phoneSeq = 1000;
export function guestInput(extra: Record<string, unknown> = {}) {
  phoneSeq++;
  return { fullName: `Guest ${uniq()}`, phone: `0803${String(Date.now() % 1000).padStart(3, '0')}${String(phoneSeq).slice(-4)}`, ...extra };
}

export const REGISTRATION = { arrivingFrom: 'Abuja', goingTo: 'Abuja', purpose: 'BUSINESS' };
export const ID = { idType: 'NIN', idNumber: '12345678901' };

/** Books tonight in `roomId` and checks in with a complete register. Returns the reservation body. */
export async function checkedInStay(app: INestApplication, auth: Auth, hotel: Hotel, roomId: string, nights = 1) {
  const server = app.getHttpServer();
  const res = await request(server)
    .post(`${API}/reservations`)
    .set(auth)
    .send({ guest: guestInput(), roomTypeId: hotel.typeId, roomId, arrivalDate: lagosDay(0), departureDate: lagosDay(nights) })
    .expect(201);
  const ci = await request(server)
    .post(`${API}/reservations/${res.body.id}/check-in`)
    .set(auth)
    .send({ guest: ID, registration: REGISTRATION })
    .expect(200);
  return ci.body;
}

export async function openShift(app: INestApplication, auth: Auth, floatKobo = 1_000_000) {
  const res = await request(app.getHttpServer()).post(`${API}/shifts/open`).set(auth).send({ openingFloatKobo: floatKobo }).expect(201);
  return res.body.id as string;
}
