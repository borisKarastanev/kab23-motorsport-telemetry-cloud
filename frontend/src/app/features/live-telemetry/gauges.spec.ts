import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Gauges } from './gauges';
import { LiveFrame } from '../../core/models/live-telemetry.model';

function makeFrame(overrides: Partial<LiveFrame> = {}): LiveFrame {
  return {
    v: 1,
    sessionId: 'session-1',
    carId: 'car-1',
    t: 0,
    pt: 0,
    seq: 1,
    speed: 142,
    rpm: 6200,
    coolant: 91.4,
    oil: 96.2,
    lap: 3,
    lapMs: 92184,
    gx: 1.23,
    gy: -0.87,
    ...overrides,
  };
}

describe('Gauges', () => {
  let fixture: ComponentFixture<Gauges>;

  const setFrame = (frame: LiveFrame | null) => {
    fixture.componentRef.setInput('frame', frame);
    fixture.detectChanges();
  };

  const reading = (label: string) => {
    const dt = Array.from(fixture.nativeElement.querySelectorAll('dt') as NodeListOf<HTMLElement>)
      .find((el) => el.textContent === label);
    const dd = dt?.nextElementSibling as HTMLElement;
    return {
      value: dd?.querySelector('.value')?.textContent,
      unit: dd?.querySelector('.unit')?.textContent ?? null,
    };
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Gauges] });
    fixture = TestBed.createComponent(Gauges);
  });

  it('renders every channel as an em dash with no frame', () => {
    setFrame(null);

    expect(reading('Speed')).toEqual({ value: '—', unit: 'km/h' });
    expect(reading('RPM')).toEqual({ value: '—', unit: null });
    expect(reading('Coolant')).toEqual({ value: '—', unit: '°C' });
    expect(reading('Oil')).toEqual({ value: '—', unit: '°C' });
    expect(reading('Lap')).toEqual({ value: '—', unit: null });
    expect(reading('Lap time')).toEqual({ value: '—', unit: null });
    expect(reading('G lat')).toEqual({ value: '—', unit: 'g' });
    expect(reading('G long')).toEqual({ value: '—', unit: 'g' });
  });

  it('formats every channel from a full frame, each to its own precision', () => {
    setFrame(makeFrame());

    expect(reading('Speed')).toEqual({ value: '142', unit: 'km/h' });
    expect(reading('RPM')).toEqual({ value: '6200', unit: null });
    expect(reading('Coolant')).toEqual({ value: '91.4', unit: '°C' });
    expect(reading('Oil')).toEqual({ value: '96.2', unit: '°C' });
    expect(reading('Lap')).toEqual({ value: '3', unit: null });
    expect(reading('Lap time')).toEqual({ value: '1:32.2', unit: null });
    expect(reading('G lat')).toEqual({ value: '1.23', unit: 'g' });
    expect(reading('G long')).toEqual({ value: '-0.87', unit: 'g' });
  });

  it('reads a genuine zero as "0", not as an em dash', () => {
    // A channel reporting zero and a channel the car is not sending at all are
    // different things, and the component's whole `show()` helper exists to
    // tell them apart.
    setFrame(makeFrame({ speed: 0, rpm: 0 }));

    expect(reading('Speed').value).toBe('0');
    expect(reading('RPM').value).toBe('0');
  });

  it('dashes a single missing channel without disturbing the others', () => {
    setFrame(makeFrame({ coolant: undefined }));

    expect(reading('Coolant').value).toBe('—');
    expect(reading('Oil').value).toBe('96.2');
  });
});
